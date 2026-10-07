import { effectiveDuration } from "../core/time";
import type { Project, Seconds } from "../core/types";

/**
 * The playback clock.
 *
 * Time lives here rather than in React state: the canvas, the timeline playhead
 * and the timecode all subscribe imperatively, so a 60 Hz playhead never causes
 * a React re-render of the editor shell.
 */

export type FrameListener = (time: Seconds, playing: boolean) => void;

export class PlaybackEngine {
  /** Authoritative playhead position, in seconds. */
  time: Seconds = 0;
  playing = false;
  rate = 1;
  duration: Seconds = 30;
  loop = true;
  fps = 30;
  /** In/out points for region playback & export. `null` means open-ended. */
  inPoint: Seconds | null = null;
  outPoint: Seconds | null = null;
  /**
   * Bumped whenever the playhead **jumps** (a scrub, the loop wrap, play-from-end).
   *
   * A real jump is the one case where the media must be dragged to a new position
   * immediately — including backwards — rather than waiting for the drift to prove
   * itself. The pool needs to know the difference, so the jump is recorded here.
   */
  epoch = 0;
  private listeners = new Set<FrameListener>();
  private raf = 0;
  private lastTs = 0;
  private dirty = true;
  private running = false;

  /** Called when playback reaches the end with looping disabled. */
  onEnded?: () => void;

  /* ---------------------------------------------------------------- *
   * Subscription
   * ---------------------------------------------------------------- */

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    this.dirty = true;
    this.start();
    listener(this.time, this.playing);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Marks the frame stale so the next animation frame re-renders. */
  invalidate(): void {
    this.dirty = true;
    this.start();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.time, this.playing);
  }

  private start(): void {
    if (this.running || typeof requestAnimationFrame === "undefined") return;
    this.running = true;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
  }

  private tick = (ts: number): void => {
    /*
     * 播放中**不能**把长帧裁得太狠。
     *
     * 原来的上限是 0.25s：窗口被切到后台时 rAF 会被节流到 ~1Hz，每帧都裁成 0.25s，
     * 于是时钟只按真实时间的四分之一走——而素材在按真实时间播。两者越差越远，漂移
     * 纠正每 500ms 就把素材**往回拽**一次，画面和声音就在同一段反复。
     *
     * 现在放到 2s（仍然挡住"机器休眠几分钟"这种真跳变）：一秒以内的卡顿不再让时钟
     * 丢掉时间。**不能**改用"追随领先的素材"来补这个洞——两个视频一起播时，追随领先
     * 最远的那一个会把另一个判成落后，它就会每 500ms 被 seek 一次（"其中一个一直卡"）。
     * 让时钟自己别丢时间，才是对所有元素都公平的做法。
     */
    const dt = Math.min(2, (ts - this.lastTs) / 1000);
    this.lastTs = ts;

    if (this.playing) {
      this.time += dt * this.rate;
      const lo = this.inPoint ?? 0;
      const hi = this.outPoint ?? this.duration;
      if (this.rate >= 0 && this.time >= hi) {
        if (this.loop) {
          this.time = hi === lo ? lo : lo + ((this.time - lo) % (hi - lo));
          this.epoch += 1;
        } else {
          this.time = hi;
          this.playing = false;
          this.onEnded?.();
        }
      } else if (this.rate < 0 && this.time <= lo) {
        if (this.loop) {
          this.time = hi;
          this.epoch += 1;
        } else {
          this.time = lo;
          this.playing = false;
          this.onEnded?.();
        }
      }
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.emit();
    }

    this.raf = requestAnimationFrame(this.tick);
  };

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */

  setDuration(project: Project): void {
    this.duration = effectiveDuration(project);
    this.fps = project.settings.fps;
    if (this.time > this.duration) this.time = this.duration;
    if (this.inPoint !== null && this.inPoint > this.duration) this.inPoint = null;
    if (this.outPoint !== null && this.outPoint > this.duration) this.outPoint = null;
    this.dirty = true;
  }

  seek(time: Seconds): void {
    const clamped = Math.max(0, Math.min(this.duration, time));
    if (clamped === this.time) {
      this.dirty = true;
      return;
    }
    this.time = clamped;
    // 真跳变：素材得被拽到新位置（包括往回拽）。
    this.epoch += 1;
    this.dirty = true;
  }

  play(): void {
    if (this.playing) return;
    const lo = this.inPoint ?? 0;
    const hi = this.outPoint ?? this.duration;
    if (this.rate >= 0 && this.time >= hi - 1e-4) {
      this.time = lo;
      this.epoch += 1;
    } else if (this.rate < 0 && this.time <= lo + 1e-4) {
      this.time = hi;
      this.epoch += 1;
    }
    this.playing = true;
    this.lastTs = performance.now();
    this.dirty = true;
    this.start();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.dirty = true;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Sets the playback rate; negative rates play in reverse. */
  setRate(rate: number): void {
    this.rate = rate;
    this.dirty = true;
  }

  markIn(): void {
    this.inPoint = this.time;
    this.dirty = true;
  }

  markOut(): void {
    this.outPoint = this.time;
    this.dirty = true;
  }

  clearInOut(): void {
    this.inPoint = null;
    this.outPoint = null;
    this.dirty = true;
  }

  clearIn(): void {
    this.inPoint = null;
    this.dirty = true;
  }

  clearOut(): void {
    this.outPoint = null;
    this.dirty = true;
  }

  stepFrames(frames: number): void {
    this.pause();
    this.seek(this.time + frames / Math.max(1, this.fps));
  }

  /** Moves by seconds while keeping the playhead frame-aligned. */
  nudge(seconds: number): void {
    const fps = Math.max(1, this.fps);
    this.seek(Math.round((this.time + seconds) * fps) / fps);
  }
}

/** Shared instance used by the editor. */
export const playback = new PlaybackEngine();
