import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { currentValue, hasKeyframes } from "../../core/animation";
import {
  applyNumberTransition,
  applyVisibleNumber,
  applyVisibleValue,
  hasAnimatableSize,
  numberAt,
  planSizeTransition,
  sizeAt,
} from "../../core/propEdit";
import { clipAsset } from "../../core/project";
import { EASING_LABELS, EASING_OPTIONS } from "../../core/easing";
import { BUILT_IN_THEMES, FONT_DISPLAY, FONT_MONO, FONT_UI, THEME_LABELS } from "../../core/theme";
import { effectiveDuration, formatDuration } from "../../core/time";
import {
  applyTransform,
  baseTargetForVisible,
  snapshotTransform,
  visibleTransformValue,
} from "../../core/transform";
import type { TransformKey } from "../../core/transform";
import type {
  Clip,
  DeviceClipProps,
  EasingName,
  FilterState,
  Keyframe,
  MediaClipProps,
  ShapeClipProps,
  SlotRecord,
  SlotValue,
  TextClipProps,
  TextStyle,
  TransitionKind,
} from "../../core/types";
import { DEFAULT_FILTERS } from "../../core/types";
import { TRANSITION_KINDS, TRANSITION_LABELS } from "../../render/effects";
import { playback } from "../../engine/PlaybackEngine";
import { buildFromTemplate } from "../../templates/apply";
import { getTemplate } from "../../templates/registry";
import type { TemplateSlot } from "../../templates/types";
import { selectedClips, useEditor } from "../../store/editorStore";
import { useShallow } from "zustand/react/shallow";
import {
  Button,
  ColorInput,
  Field,
  IconButton,
  NumberInput,
  Section,
  Segmented,
  Select,
  Slider,
  TextInput,
  Toggle,
} from "../controls";
import type { Option } from "../controls";
import { usePlayhead } from "../hooks";
import { ChevronDown, Diamond, Maximize2, Plus, SkipForward, Sparkles, Trash2 } from "../icons";

/**
 * Inspector.
 *
 * Shows template parameters when nothing is selected, project settings when the
 * project is free-form, and the selected clip's full property sheet otherwise.
 *
 * Every property a template animates can be keyframed by hand from its diamond
 * button, which always writes at the current playhead: the transform keys, plus
 * `opacity`, `filters.blur`, `props.width/height/radius/strokeWidth`,
 * `props.fill` and the text colour. Editing an animated number shifts the whole
 * curve; editing an animated colour writes into the keyframe under the playhead.
 * See `core/propEdit.ts`.
 */

type Tab = "basic" | "motion" | "effects";

/** 字体选择器候选列表。值为 CSS font-family 字符串，直接写入 TextStyle.fontFamily。 */
const FONT_OPTIONS: Array<Option<string>> = [
  { value: FONT_DISPLAY, label: "显示字体（Segoe UI Display）" },
  { value: FONT_UI, label: "界面字体（Segoe UI）" },
  { value: FONT_MONO, label: "等宽（Cascadia Code）" },
  { value: '"Microsoft YaHei", sans-serif', label: "微软雅黑" },
  { value: '"PingFang SC", sans-serif', label: "苹方" },
  { value: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif', label: "思源黑体" },
  { value: '"Source Han Serif SC", "Noto Serif CJK SC", serif', label: "思源宋体" },
  { value: '"SimHei", "Heiti SC", sans-serif', label: "黑体" },
  { value: '"SimSun", "Songti SC", serif', label: "宋体" },
  { value: '"KaiTi", "Kaiti SC", serif', label: "楷体" },
  { value: '"FangSong", "STFangsong", serif', label: "仿宋" },
  { value: 'Arial, "Helvetica Neue", sans-serif', label: "Arial" },
  { value: 'Georgia, "Times New Roman", serif', label: "Georgia" },
  { value: '"Times New Roman", Times, serif', label: "Times New Roman" },
  { value: "Impact, sans-serif", label: "Impact" },
  { value: '"Courier New", Courier, monospace', label: "Courier New" },
];

export function Inspector() {
  const clips = useEditor(useShallow(selectedClips));
  const primary = clips[0] ?? null;
  const tab = useEditor((s) => s.inspectorTab);
  const setTab = useEditor((s) => s.setInspectorTab);
  const templateId = useEditor((s) => s.project.templateId);

  const tabs: Array<Option<Tab>> = [
    { value: "basic", label: "基础" },
    { value: "motion", label: "动效" },
    { value: "effects", label: "效果" },
  ];

  return (
    <div className="qv-inspector">
      {primary && (
        <div className="qv-tabs">
          <Segmented value={tab} onChange={setTab} options={tabs} />
        </div>
      )}
      <div className="qv-panel__scroll">
        {primary ? (
          <ClipInspector clips={clips} primary={primary} tab={tab} />
        ) : templateId ? (
          <TemplateInspector templateId={templateId} />
        ) : (
          <ProjectInspector />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Keyframe-aware field
 * ------------------------------------------------------------------ */

function KeyField({
  clip,
  path,
  label,
  hint,
  children,
}: {
  clip: Clip;
  path: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const animated = hasKeyframes(clip.animation, path);
  const current = currentValue(clip, path, Math.max(0, playback.time - clip.start));

  return (
    <Field
      label={label}
      hint={hint}
      keyframed={animated}
      onKeyframe={() => {
        const localTime = Math.max(0, playback.time - clip.start);
        const value =
          typeof current === "number" || typeof current === "string" ? current : 0;
        useEditor.getState().toggleKeyframe(clip.id, path, localTime, value);
      }}
    >
      {children}
    </Field>
  );
}

/** 播放头落在该片段内的本地时刻（夹进片段范围，避免关键帧被裁掉）。 */
function localTimeOf(clip: Clip): number {
  return Math.max(0, Math.min(clip.duration, playback.time - clip.start));
}

/**
 * 数值属性 + 打点按钮。
 *
 * 打了关键帧之后，框里显示的是**当前时间点的实际值**，输入也按"改成这个值"理解：整条
 * 曲线同量平移（曲线形状不变），所以输入的数字就是播放头下会看到的数字。不打点的时候
 * 就是普通的属性编辑。见 `core/propEdit.ts`。
 */
function KeyNumberField({
  clip,
  path,
  label,
  hint,
  min,
  max,
  step,
  suffix,
}: {
  clip: Clip;
  path: string;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const localTime = localTimeOf(clip);
  const raw = currentValue(clip, path, localTime);
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : numberAt(clip, path, 0);

  return (
    <KeyField clip={clip} path={path} label={label} hint={hint}>
      <NumberInput
        value={value}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        onChange={(next) => {
          const { selection, updateClips } = useEditor.getState();
          updateClips(selection, (c) => applyVisibleNumber(c, path, next, localTimeOf(c)));
        }}
      />
    </KeyField>
  );
}

/**
 * 颜色属性 + 打点按钮。
 *
 * 颜色没法"平移"，所以已打点的时候改颜色是**写进播放头所在的那个关键帧**（没有就在
 * 播放头插一个）。厚边收成细线就是两个这样的点：填充从 `#241C16` 到全透明。
 */
function KeyColorField({
  clip,
  path,
  label,
  hint,
  fallback,
}: {
  clip: Clip;
  path: string;
  label: string;
  hint?: string;
  fallback: string;
}) {
  const localTime = localTimeOf(clip);
  const raw = currentValue(clip, path, localTime);
  const value = typeof raw === "string" && raw.length > 0 ? raw : fallback;

  return (
    <KeyField clip={clip} path={path} label={label} hint={hint}>
      <ColorInput
        value={value}
        onChange={(next) => {
          const store = useEditor.getState();
          // 拖动选色时建立快照，松开/选预设时 endHistory 合并为一条撤销记录。
          if (!store.pendingSnapshot) store.beginHistory();
          store.updateClips(
            store.selection,
            (c) => applyVisibleValue(c, path, next, localTimeOf(c)),
            { history: false },
          );
        }}
        onCommit={() => useEditor.getState().endHistory()}
      />
    </KeyField>
  );
}

/** 0..1 或其它区间上的滑块 + 打点按钮（不透明度、模糊都用它）。 */
function KeySlider({
  clip,
  path,
  label,
  hint,
  min = 0,
  max = 1,
  step = 0.01,
  precision,
}: {
  clip: Clip;
  path: string;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}) {
  const localTime = localTimeOf(clip);
  const raw = currentValue(clip, path, localTime);
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : numberAt(clip, path, min);

  return (
    <KeyField clip={clip} path={path} label={label} hint={hint}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        precision={precision}
        onChange={(next) => {
          const store = useEditor.getState();
          // 拖动开始时建立快照，松开时 endHistory 合并为一条撤销记录。
          if (!store.pendingSnapshot) store.beginHistory();
          store.updateClips(
            store.selection,
            (c) => applyVisibleNumber(c, path, next, localTimeOf(c)),
            { history: false },
          );
        }}
        onCommit={() => useEditor.getState().endHistory()}
      />
    </KeyField>
  );
}

/**
 * 「尺寸过渡」——一次点击写出"从这里开始，N 秒内长到这个尺寸"。
 *
 * 只给了目标宽/高与时长：起点就是这个图层**此刻的可见尺寸**，所以不用填两遍数字。
 * 一叠"外框 + 截图"会按**同一个增量**一起动（边框厚度不变），这由
 * `planSizeTransition` 算好；多选时会带动所有选中的尺寸图层，整次操作只占一步撤销。
 */
function SizeTransitionTool({ clip }: { clip: Clip }) {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);

  const selected = useMemo(() => {
    const byId = new Map<string, Clip>();
    for (const track of project.tracks) {
      for (const item of track.clips) byId.set(item.id, item);
    }
    const list = selection.map((id) => byId.get(id)).filter((c): c is Clip => !!c);
    const sizeable = (list.length > 0 ? list : [clip]).filter(hasAnimatableSize);
    return sizeable.length > 0 ? sizeable : hasAnimatableSize(clip) ? [clip] : [];
  }, [project, selection, clip]);

  const reference = selected.includes(clip) ? clip : selected[0];
  const baseWidth = reference ? Math.round(sizeAt(reference, "width", 0)) : 0;
  const baseHeight = reference ? Math.round(sizeAt(reference, "height", 0)) : 0;

  const [target, setTarget] = useState({ width: 0, height: 0 });
  const [duration, setDuration] = useState(0.6);

  // 换选中的图层时，把目标尺寸重置成它的当前尺寸——不重置的话会把上一张卡的尺寸
  // 带过来，看着像"数字自己变了"。
  const referenceId = reference?.id ?? "";
  useEffect(() => {
    setTarget({ width: baseWidth, height: baseHeight });
  }, [referenceId, baseWidth, baseHeight]);

  if (selected.length === 0) {
    return (
      <p className="qv-panel__note">
        这个图层没有可动画的尺寸属性（只有「形状」与「界面演示」有宽高）。
      </p>
    );
  }

  const apply = () => {
    const items = selected.map((item) => ({ clip: item, at: localTimeOf(item) }));
    const referenceIndex = Math.max(0, items.findIndex((i) => i.clip.id === referenceId));
    const plan = planSizeTransition(items, referenceIndex, target);
    if (plan.length === 0) return;

    const seconds = Math.max(1 / 30, duration);
    useEditor.getState().updateClips(
      plan.map((p) => p.id),
      (c) => {
        const p = plan.find((entry) => entry.id === c.id);
        if (!p) return c;
        let next = applyNumberTransition({
          clip: c,
          path: "props.width",
          target: p.width,
          at: localTimeOf(c),
          duration: seconds,
        });
        next = applyNumberTransition({
          clip: next,
          path: "props.height",
          target: p.height,
          at: localTimeOf(next),
          duration: seconds,
        });
        return next;
      },
    );
    useEditor.getState().setStatus(
      `尺寸过渡：${seconds.toFixed(2)}s 内动到 ${Math.round(target.width)}×${Math.round(
        target.height,
      )}px（${plan.length} 个图层）`,
    );
  };

  return (
    <>
      <div className="qv-grid2">
        <Field label="目标宽">
          <NumberInput
            value={target.width}
            min={1}
            max={6000}
            step={10}
            suffix="px"
            onChange={(width) => setTarget((t) => ({ ...t, width }))}
          />
        </Field>
        <Field label="目标高">
          <NumberInput
            value={target.height}
            min={1}
            max={6000}
            step={10}
            suffix="px"
            onChange={(height) => setTarget((t) => ({ ...t, height }))}
          />
        </Field>
      </div>
      <Field label="时长" hint="起点是播放头所在时刻，终点 = 起点 + 时长">
        <NumberInput
          value={duration}
          min={1 / 30}
          max={10}
          step={0.1}
          suffix="s"
          onChange={setDuration}
        />
      </Field>
      <Button variant="primary" icon={<Maximize2 size={14} />} onClick={apply} full>
        在当前播放头应用尺寸过渡
      </Button>
      <p className="qv-panel__note">
        会对选中的 {selected.length} 个尺寸图层施加**同一个增量**
        {selected.length > 1 ? "（外框与截图的边框厚度保持不变）" : ""}；上方尺寸框里填的
        是参考图层「{reference?.name ?? ""}」当前尺寸。
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Clip inspector
 * ------------------------------------------------------------------ */

function ClipInspector({ clips, primary, tab }: { clips: Clip[]; primary: Clip; tab: Tab }) {
  const updateMany = useEditor((s) => s.updateClips);
  const setStatus = useEditor((s) => s.setStatus);
  const project = useEditor((s) => s.project);

  const ids = clips.map((c) => c.id);
  const multi = clips.length > 1;
  const clip = primary;
  const patch = (p: Parameters<typeof updateMany>[1]) => updateMany(ids, p);
  const setProps = (props: Record<string, unknown>) => patch({ props });
  // Live (no-history) patch for continuous drag gestures: beginHistory on first
  // tick, endHistory on commit. ColorInput drags use this so the undo stack
  // records one entry per gesture instead of one per pixel.
  const patchLive = (p: Parameters<typeof updateMany>[1]) => {
    const store = useEditor.getState();
    if (!store.pendingSnapshot) store.beginHistory();
    updateMany(ids, p, { history: false });
  };
  const setPropsLive = (props: Record<string, unknown>) => patchLive({ props });
  const commitLive = () => useEditor.getState().endHistory();

  // How much of the source file this clip may draw on, and how much it needs.
  // `null` for kinds with no media behind them (text, shape, background).
  const sourceLength = (() => {
    const asset = clipAsset(project, clip);
    if (!asset) return null;
    if (asset.kind !== "video" && asset.kind !== "audio") return null;
    const total = asset.duration;
    return total && total > 0 ? total : null;
  })();
  const speed = clip.speed > 0 ? clip.speed : 1;
  const usedSource = clip.trimIn + clip.duration * speed;
  const overSource = sourceLength !== null && usedSource > sourceLength + 1e-6;

  if (tab === "motion") return <MotionTab clip={clip} />;
  if (tab === "effects") return <EffectsTab clip={clip} />;

  return (
    <>
      <Section title="片段">
        {multi && (
          <div className="qv-alert qv-alert--info">已选中 {clips.length} 个片段，属性修改将批量应用</div>
        )}
        <Field label="名称">
          <TextInput
            value={multi ? `已选中 ${clips.length} 个片段` : clip.name}
            onChange={(name) => patch({ name })}
            disabled={multi}
          />
        </Field>
        <div className="qv-grid2">
          <Field label="开始">
            <NumberInput
              value={clip.start}
              min={0}
              step={1 / 30}
              suffix="s"
              onChange={(start) => patch({ start: Math.max(0, start) })}
              disabled={multi}
            />
          </Field>
          <Field label="时长">
            <NumberInput
              value={clip.duration}
              min={1 / 30}
              step={1 / 30}
              suffix="s"
              onChange={(duration) => patch({ duration: Math.max(1 / 30, duration) })}
              disabled={multi}
            />
          </Field>
        </div>
        <div className="qv-grid2">
          <Field label="源内偏移" hint="从素材的第几秒开始取">
            <NumberInput
              value={clip.trimIn}
              min={0}
              step={0.1}
              suffix="s"
              onChange={(trimIn) => patch({ trimIn: Math.max(0, trimIn) })}
              disabled={multi}
            />
          </Field>
          <Field label="速度">
            <NumberInput
              value={clip.speed}
              min={0.05}
              max={8}
              step={0.05}
              suffix="×"
              onChange={(speed) => useEditor.getState().setClipSpeed(clip.id, speed)}
              disabled={multi}
            />
          </Field>
        </div>
        {!multi && (
          <div className="qv-speed-presets">
            {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => (
              <button
                key={s}
                type="button"
                className={
                  Math.abs(clip.speed - s) < 0.01
                    ? "qv-speed-presets__btn qv-speed-presets__btn--on"
                    : "qv-speed-presets__btn"
                }
                onClick={() => useEditor.getState().setClipSpeed(clip.id, s)}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
        {/*
          Shows how much of the file the clip may use. Without it, the constraint
          that shortens a clip (in-point pushed too far, or relinked to a shorter
          file) is invisible and the clip just silently gets shorter.
        */}
        {sourceLength !== null && (
          <div className="qv-usage">
            <span className={overSource ? "qv-usage--over" : undefined}>
              素材 {sourceLength.toFixed(1)}s · 本片段使用 {clip.trimIn.toFixed(2)}s –{" "}
              {usedSource.toFixed(2)}s
            </span>
            {overSource && (
              <span className="qv-usage__warn">超出素材长度，已按可用长度缩短</span>
            )}
          </div>
        )}
        <KeySlider
          clip={clip}
          path="opacity"
          label="不透明度"
          hint="可打关键帧；配尺寸过渡就是「淡出换卡」"
        />
        <Field label="启用">
          <Toggle checked={clip.enabled} onChange={(enabled) => patch({ enabled })} />
        </Field>
      </Section>

      {!multi && clip.kind === "text" && (
        <TextSection
          clip={clip}
          props={clip.props as TextClipProps}
          setProps={setProps}
          setPropsLive={setPropsLive}
          commitLive={commitLive}
        />
      )}
      {!multi && (clip.kind === "image" || clip.kind === "video" || clip.kind === "audio") && (
        <MediaSection
          clip={clip}
          kind={clip.kind}
          props={clip.props as MediaClipProps}
          setProps={setProps}
        />
      )}
      {!multi && clip.kind === "video" && (
        <VolumeSection clip={clip} props={clip.props as MediaClipProps} setProps={setProps} />
      )}
      {!multi && clip.kind === "shape" && (
        <ShapeSection
          clip={clip}
          props={clip.props as ShapeClipProps}
          setProps={setProps}
          setPropsLive={setPropsLive}
          commitLive={commitLive}
        />
      )}
      {!multi && clip.kind === "device" && (
        <DeviceSection
          clip={clip}
          props={clip.props as DeviceClipProps}
          setProps={setProps}
          setPropsLive={setPropsLive}
          commitLive={commitLive}
        />
      )}
      {!multi && (clip.kind === "shape" || clip.kind === "device") && (
        <Section title="尺寸过渡">
          <SizeTransitionTool clip={clip} />
        </Section>
      )}

      <TransformSection clip={clip} patch={patch} ids={ids} />

      <Section title="转场" defaultOpen={false}>
        <TransitionRow
          label="入场"
          value={clip.transitionIn}
          onChange={(t) => patch({ transitionIn: t })}
        />
        <TransitionRow
          label="出场"
          value={clip.transitionOut}
          onChange={(t) => patch({ transitionOut: t })}
        />
        <p className="qv-panel__note">
          转场只作用于当前片段本身，因此任何图层都能叠加在任意背景上。
        </p>
      </Section>

      <Section title="图层混合" defaultOpen={false}>
        <Field label="混合模式">
          <Select
            value={(clip.blendMode ?? "source-over") as GlobalCompositeOperation}
            onChange={(blendMode) => patch({ blendMode })}
            options={BLEND_OPTIONS}
          />
        </Field>
      </Section>

      <div className="qv-inspector__foot">
        <Button
          variant="ghost"
          onClick={() => {
            useEditor.getState().clearAnimation(clip.id);
            setStatus("已清除该片段的全部关键帧", "success");
          }}
        >
          清除全部关键帧
        </Button>
      </div>
    </>
  );
}

const BLEND_OPTIONS: Array<Option<GlobalCompositeOperation>> = [
  { value: "source-over", label: "正常" },
  { value: "lighter", label: "叠加发光 (Add)" },
  { value: "screen", label: "滤色 (Screen)" },
  { value: "multiply", label: "正片叠底" },
  { value: "overlay", label: "叠加 (Overlay)" },
  { value: "soft-light", label: "柔光" },
  { value: "difference", label: "差值" },
];

/* ------------------------------------------------------------------ *
 * Per-kind property sections
 * ------------------------------------------------------------------ */

function TextSection({
  clip,
  props,
  setProps,
  setPropsLive,
  commitLive,
}: {
  clip: Clip;
  props: TextClipProps;
  setProps: (props: Record<string, unknown>) => void;
  setPropsLive: (props: Record<string, unknown>) => void;
  commitLive: () => void;
}) {
  const style = props.style;
  const setStyle = (patch: Partial<TextStyle>) => setProps({ style: { ...style, ...patch } });
  const setStyleLive = (patch: Partial<TextStyle>) => setPropsLive({ style: { ...style, ...patch } });

  const alignOptions: Array<Option<TextStyle["align"]>> = [
    { value: "left", label: "左对齐" },
    { value: "center", label: "居中" },
    { value: "right", label: "右对齐" },
  ];
  const revealOptions: Array<Option<TextClipProps["reveal"]>> = [
    { value: "none", label: "无" },
    { value: "typewriter", label: "打字机" },
    { value: "wordRise", label: "逐词上浮" },
    { value: "charPop", label: "逐字弹出" },
    { value: "maskWipe", label: "遮罩推开" },
    { value: "blurIn", label: "模糊聚焦" },
  ];

  return (
    <>
      <Section title="文字内容">
        <Field label="文案" hint="支持换行，中文会自动按字断行">
          <TextInput value={props.text} onChange={(text) => setProps({ text })} multiline />
        </Field>
      </Section>

      <Section title="排版">
        <Field label="字体">
          <Select
            value={style.fontFamily}
            onChange={(fontFamily) => setStyle({ fontFamily })}
            options={FONT_OPTIONS}
          />
        </Field>
        <div className="qv-grid2">
          <Field label="字号">
            <NumberInput
              value={style.fontSize}
              min={8}
              max={600}
              step={2}
              onChange={(fontSize) => setStyle({ fontSize })}
            />
          </Field>
          <Field label="字重">
            <NumberInput
              value={style.fontWeight}
              min={100}
              max={900}
              step={100}
              onChange={(fontWeight) => setStyle({ fontWeight })}
            />
          </Field>
        </div>
        <div className="qv-grid2">
          <Field label="行高">
            <NumberInput
              value={style.lineHeight}
              min={0.7}
              max={3}
              step={0.05}
              precision={2}
              onChange={(lineHeight) => setStyle({ lineHeight })}
            />
          </Field>
          <Field label="字距" hint="em">
            <NumberInput
              value={style.letterSpacing}
              min={-0.2}
              max={0.6}
              step={0.01}
              precision={3}
              onChange={(letterSpacing) => setStyle({ letterSpacing })}
            />
          </Field>
        </div>
        <Field label="对齐">
          <Segmented value={style.align} onChange={(align) => setStyle({ align })} options={alignOptions} />
        </Field>
        <Field label="换行宽度" hint="0 表示不自动换行">
          <NumberInput
            value={style.maxWidth}
            min={0}
            max={4000}
            step={20}
            suffix="px"
            onChange={(maxWidth) => setStyle({ maxWidth })}
          />
        </Field>
        <KeyColorField
          clip={clip}
          path="props.style.color"
          label="颜色"
          fallback={style.color}
          hint="可打关键帧；清单「聚焦变焦糖色」就是它"
        />
      </Section>

      <Section title="渐变填充" defaultOpen={false}>
        <Field label="启用渐变">
          <Toggle
            checked={style.gradient.enabled}
            onChange={(enabled) => setStyle({ gradient: { ...style.gradient, enabled } })}
          />
        </Field>
        {style.gradient.enabled && (
          <>
            <div className="qv-grid2">
              <Field label="起始色">
                <ColorInput
                  value={style.gradient.from}
                  onChange={(from) => setStyleLive({ gradient: { ...style.gradient, from } })}
                  onCommit={commitLive}
                />
              </Field>
              <Field label="结束色">
                <ColorInput
                  value={style.gradient.to}
                  onChange={(to) => setStyleLive({ gradient: { ...style.gradient, to } })}
                  onCommit={commitLive}
                />
              </Field>
            </div>
            <Field label="角度">
              <Slider
                value={style.gradient.angle}
                min={0}
                max={360}
                step={1}
                precision={0}
                onChange={(angle) => setStyle({ gradient: { ...style.gradient, angle } })}
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="描边与光晕" defaultOpen={false}>
        <Field label="描边宽度">
          <Slider
            value={style.strokeWidth}
            min={0}
            max={24}
            step={0.5}
            precision={1}
            onChange={(strokeWidth) => setStyle({ strokeWidth })}
          />
        </Field>
        {style.strokeWidth > 0 && (
          <Field label="描边颜色">
            <ColorInput
              value={style.strokeColor}
              onChange={(strokeColor) => setStyleLive({ strokeColor })}
              onCommit={commitLive}
            />
          </Field>
        )}
        <Field label="光晕强度">
          <Slider
            value={style.glowBlur}
            min={0}
            max={90}
            step={1}
            precision={0}
            onChange={(glowBlur) => setStyle({ glowBlur })}
          />
        </Field>
        {style.glowBlur > 0 && (
          <Field label="光晕颜色">
            <ColorInput
              value={style.glowColor}
              onChange={(glowColor) => setStyleLive({ glowColor })}
              onCommit={commitLive}
            />
          </Field>
        )}
      </Section>

      <Section title="出现动画" defaultOpen={false}>
        <Field label="方式">
          <Select
            value={props.reveal}
            onChange={(reveal) => setProps({ reveal })}
            options={revealOptions}
          />
        </Field>
        {props.reveal !== "none" && (
          <>
            <Field label="总时长">
              <Slider
                value={props.revealDuration}
                min={0.1}
                max={4}
                step={0.05}
                onChange={(revealDuration) => setProps({ revealDuration })}
              />
            </Field>
            <Field label="逐个延迟">
              <Slider
                value={props.revealStagger}
                min={0}
                max={0.3}
                step={0.005}
                precision={3}
                onChange={(revealStagger) => setProps({ revealStagger })}
              />
            </Field>
            {props.reveal === "typewriter" && (
              <Field label="光标">
                <Toggle checked={props.caret} onChange={(caret) => setProps({ caret })} />
              </Field>
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** Volume with keyframe support, shared by audio clips and videos with sound. */
function VolumeSection({
  clip,
  props,
  setProps,
}: {
  clip: Clip;
  props: MediaClipProps;
  setProps: (props: Record<string, unknown>) => void;
}) {
  /**
   * Writes a fade as volume keyframes.
   *
   * Merges with whatever is already there and re-sorts, so pressing 淡入 then
   * 淡出 yields a proper fade in *and* out rather than one overwriting the other.
   */
  const addFade = (side: "in" | "out") => {
    const target = props.volume > 0 ? props.volume : 1;
    const span = Math.min(1, clip.duration);
    const frames: Keyframe[] =
      side === "in"
        ? [
            { time: 0, value: 0, easing: "linear" },
            { time: span, value: target, easing: "easeOutQuad" },
          ]
        : [
            { time: Math.max(0, clip.duration - span), value: target, easing: "easeInQuad" },
            { time: clip.duration, value: 0, easing: "linear" },
          ];
    const merged = [...(clip.animation["props.volume"] ?? []), ...frames].sort(
      (a, b) => a.time - b.time,
    );
    useEditor.getState().setKeyframes(clip.id, "props.volume", merged);
  };

  const hasFade = (clip.animation["props.volume"]?.length ?? 0) > 0;

  return (
    <Section title="音频">
      <KeyField clip={clip} path="props.volume" label="音量" hint="可打关键帧做淡入淡出">
        <Slider
          value={props.volume}
          min={0}
          max={2}
          step={0.01}
          onChange={(volume) => setProps({ volume })}
        />
      </KeyField>
      <div className="qv-quick-grid">
        <Button onClick={() => addFade("in")}>淡入 1 秒</Button>
        <Button onClick={() => addFade("out")}>淡出 1 秒</Button>
      </div>
      {hasFade && (
        <>
          <p className="qv-panel__note">
            已有 {clip.animation["props.volume"].length} 个音量关键帧，预览与导出的 MP4 都会应用。
            逐点微调请到「动效」标签页。
          </p>
          <Button
            variant="ghost"
            full
            onClick={() => useEditor.getState().clearAnimation(clip.id, "props.volume")}
          >
            清除音量关键帧
          </Button>
        </>
      )}
      <Field label="静音">
        <Toggle checked={props.muted} onChange={(muted) => setProps({ muted })} />
      </Field>
    </Section>
  );
}

function MediaSection({
  clip,
  kind,
  props,
  setProps,
}: {
  clip: Clip;
  kind: "image" | "video" | "audio";
  props: MediaClipProps;
  setProps: (props: Record<string, unknown>) => void;
}) {
  const fitOptions: Array<Option<MediaClipProps["fit"]>> = [
    { value: "cover", label: "填满裁切" },
    { value: "contain", label: "完整显示" },
    { value: "fill", label: "拉伸" },
    { value: "none", label: "原始尺寸" },
  ];

  if (kind === "audio") {
    return <VolumeSection clip={clip} props={props} setProps={setProps} />;
  }

  return (
    <Section title="画面">
      <Field label="适配方式">
        <Select value={props.fit} onChange={(fit) => setProps({ fit })} options={fitOptions} />
      </Field>
      <Field label="圆角">
        <Slider
          value={props.radius}
          min={0}
          max={200}
          step={1}
          precision={0}
          onChange={(radius) => setProps({ radius })}
        />
      </Field>
      {(props.fit === "cover" || props.fit === "none") && (
        <>
          <Field label="水平焦点">
            <Slider
              value={props.focusX}
              min={0}
              max={1}
              onChange={(focusX) => setProps({ focusX })}
            />
          </Field>
          <Field label="垂直焦点">
            <Slider
              value={props.focusY}
              min={0}
              max={1}
              onChange={(focusY) => setProps({ focusY })}
            />
          </Field>
        </>
      )}
      {kind === "video" && (
        <Field label="静音">
          <Toggle checked={props.muted} onChange={(muted) => setProps({ muted })} />
        </Field>
      )}
    </Section>
  );
}

function ShapeSection({
  clip,
  props,
  setProps,
  setPropsLive,
  commitLive,
}: {
  clip: Clip;
  props: ShapeClipProps;
  setProps: (props: Record<string, unknown>) => void;
  setPropsLive: (props: Record<string, unknown>) => void;
  commitLive: () => void;
}) {
  const shapeOptions: Array<Option<ShapeClipProps["shape"]>> = [
    { value: "rect", label: "矩形" },
    { value: "ellipse", label: "椭圆" },
    { value: "triangle", label: "三角形" },
    { value: "star", label: "星形" },
    { value: "line", label: "直线" },
    { value: "arrow", label: "箭头" },
  ];

  return (
    <Section title="形状">
      <Field label="类型">
        <Select value={props.shape} onChange={(shape) => setProps({ shape })} options={shapeOptions} />
      </Field>
      <div className="qv-grid2">
        <KeyNumberField
          clip={clip}
          path="props.width"
          label="宽"
          min={1}
          max={6000}
          step={10}
          suffix="px"
        />
        <KeyNumberField
          clip={clip}
          path="props.height"
          label="高"
          min={1}
          max={6000}
          step={10}
          suffix="px"
        />
      </div>
      <KeyColorField clip={clip} path="props.fill" label="填充色" fallback={props.fill} />
      <Field label="使用渐变">
        <Toggle
          checked={props.fillGradient.enabled}
          onChange={(enabled) => setProps({ fillGradient: { ...props.fillGradient, enabled } })}
        />
      </Field>
      {props.fillGradient.enabled && (
        <div className="qv-grid2">
          <Field label="起始色">
            <ColorInput
              value={props.fillGradient.from}
              onChange={(from) => setPropsLive({ fillGradient: { ...props.fillGradient, from } })}
              onCommit={commitLive}
            />
          </Field>
          <Field label="结束色">
            <ColorInput
              value={props.fillGradient.to}
              onChange={(to) => setPropsLive({ fillGradient: { ...props.fillGradient, to } })}
              onCommit={commitLive}
            />
          </Field>
        </div>
      )}
      {props.shape === "rect" && (
        <KeySlider
          clip={clip}
          path="props.radius"
          label="圆角"
          min={0}
          max={400}
          step={1}
          precision={0}
        />
      )}
      {props.shape === "star" && (
        <>
          <Field label="角数">
            <NumberInput
              value={props.points}
              min={3}
              max={20}
              step={1}
              onChange={(points) => setProps({ points })}
            />
          </Field>
          <Field label="内径比">
            <Slider
              value={props.innerRadius}
              min={0.05}
              max={0.95}
              onChange={(innerRadius) => setProps({ innerRadius })}
            />
          </Field>
        </>
      )}
      <KeySlider
        clip={clip}
        path="props.strokeWidth"
        label="描边宽度"
        min={0}
        max={40}
        step={0.5}
        precision={1}
      />
      {props.strokeWidth > 0 && (
        <Field label="描边颜色">
          <ColorInput
            value={props.strokeColor}
            onChange={(strokeColor) => setPropsLive({ strokeColor })}
            onCommit={commitLive}
          />
        </Field>
      )}
    </Section>
  );
}

function DeviceSection({
  clip,
  props,
  setProps,
  setPropsLive,
  commitLive,
}: {
  clip: Clip;
  props: DeviceClipProps;
  setProps: (props: Record<string, unknown>) => void;
  setPropsLive: (props: Record<string, unknown>) => void;
  commitLive: () => void;
}) {
  const deviceOptions: Array<Option<DeviceClipProps["device"]>> = [
    { value: "browser", label: "浏览器窗口" },
    { value: "window", label: "桌面窗口" },
    { value: "phone", label: "手机" },
    { value: "tablet", label: "平板" },
    { value: "bare", label: "无边框" },
  ];
  const project = useEditor((s) => s.project);
  /**
   * 「界面演示」里可以放**图片或视频**。
   *
   * 视频就是"屏幕录像"：嵌在同一个设备外壳里、跟着卡片的尺寸/圆角/描边一起走，
   * 解码链路和视频图层完全一样（`MediaPool` 会 seek/播放它），只是强制静音——
   * 嵌在界面卡片里的录像出声没有意义，参考片的设备演示也从来没有声音。
   */
  const media = useMemo(
    () => project.assets.filter((a) => a.kind === "image" || a.kind === "video"),
    [project.assets],
  );
  const current = media.find((a) => a.id === props.assetId);

  return (
    <Section title="界面演示">
      <Field label="外壳">
        <Select value={props.device} onChange={(device) => setProps({ device })} options={deviceOptions} />
      </Field>
      <Field
        label="界面素材"
        hint={
          current?.kind === "video"
            ? "视频素材：嵌在外壳里播放，强制静音。"
            : undefined
        }
      >
        <Select
          value={props.assetId}
          onChange={(assetId) => setProps({ assetId })}
          options={[
            {
              value: "",
              label: media.length > 0 ? "（使用素材库里的第一个）" : "（素材库是空的）",
            },
            ...media.map((a) => ({
              value: a.id,
              label: a.kind === "video" ? `${a.name} · 视频` : a.name,
            })),
          ]}
        />
      </Field>
      <div className="qv-grid2">
        <KeyNumberField
          clip={clip}
          path="props.width"
          label="宽"
          min={80}
          max={4000}
          step={10}
          suffix="px"
        />
        <KeyNumberField
          clip={clip}
          path="props.height"
          label="高"
          min={60}
          max={4000}
          step={10}
          suffix="px"
        />
      </div>
      {props.device === "browser" && (
        <Field label="地址栏文字">
          <TextInput value={props.url} onChange={(url) => setProps({ url })} />
        </Field>
      )}
      <Field label="边框颜色">
        <ColorInput
          value={props.frameColor}
          onChange={(frameColor) => setPropsLive({ frameColor })}
          onCommit={commitLive}
        />
      </Field>
      <div className="qv-grid2">
        <Field label="水平倾斜">
          <Slider
            value={props.tiltY}
            min={-45}
            max={45}
            step={1}
            precision={0}
            onChange={(tiltY) => setProps({ tiltY })}
          />
        </Field>
        <Field label="垂直倾斜">
          <Slider
            value={props.tiltX}
            min={-45}
            max={45}
            step={1}
            precision={0}
            onChange={(tiltX) => setProps({ tiltX })}
          />
        </Field>
      </div>
      <Field label="内边距">
        <Slider
          value={props.padding}
          min={0}
          max={80}
          step={1}
          precision={0}
          onChange={(padding) => setProps({ padding })}
        />
      </Field>
      <KeySlider
        clip={clip}
        path="props.scroll"
        label="取景滚动"
        min={0}
        max={1}
        hint="长截图在窗口内滚到底的比例：0 顶对齐，1 底对齐。可打点做滚动。"
      />
      <KeySlider
        clip={clip}
        path="props.radius"
        label="圆角"
        min={0}
        max={120}
        step={1}
        precision={0}
      />
      <Field label="投影">
        <Toggle checked={props.shadow} onChange={(shadow) => setProps({ shadow })} />
      </Field>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Shared sections
 * ------------------------------------------------------------------ */

function TransformSection({
  clip,
  patch,
  ids,
}: {
  clip: Clip;
  patch: (patch: Parameters<ReturnType<typeof useEditor.getState>["updateClip"]>[1]) => void;
  ids: string[];
}) {
  // Subscribed so the fields show the value that is actually on screen at the
  // playhead while an animated clip is being scrubbed.
  usePlayhead(110);
  const localTime = Math.max(0, playback.time - clip.start);
  const t = clip.transform;

  /**
   * Writes a *visible* value.
   *
   * Typing into these fields used to write the base transform, which an
   * entrance animation would immediately override — the field looked broken on
   * any clip whose transform was keyframed. Converting to the base value and
   * carrying the keyframes along makes the number mean what it says.
   */
  const setKey = (key: TransformKey, desired: number) => {
    useEditor.getState().updateClips(ids, (c) => {
      const snap = snapshotTransform(c);
      const target = baseTargetForVisible(c, snap, key, desired, Math.max(0, playback.time - c.start));
      return applyTransform(c, snap, { [key]: target });
    });
  };

  const animated = (key: TransformKey) => hasKeyframes(clip.animation, `transform.${key}`);

  return (
    <Section title="变换">
      <div className="qv-grid2">
        <KeyField clip={clip} path="transform.x" label="水平位移">
          <NumberInput
            value={round2(visibleTransformValue(clip, "x", localTime))}
            step={2}
            suffix="px"
            onChange={(x) => setKey("x", x)}
          />
        </KeyField>
        <KeyField clip={clip} path="transform.y" label="垂直位移">
          <NumberInput
            value={round2(visibleTransformValue(clip, "y", localTime))}
            step={2}
            suffix="px"
            onChange={(y) => setKey("y", y)}
          />
        </KeyField>
      </div>
      <KeyField clip={clip} path="transform.scale" label="缩放">
        <Slider
          value={visibleTransformValue(clip, "scale", localTime)}
          min={0.02}
          max={4}
          step={0.01}
          onChange={(scale) => setKey("scale", scale)}
        />
      </KeyField>
      <KeyField clip={clip} path="transform.rotation" label="旋转">
        <Slider
          value={visibleTransformValue(clip, "rotation", localTime)}
          min={-180}
          max={180}
          step={1}
          precision={0}
          onChange={(rotation) => setKey("rotation", rotation)}
        />
      </KeyField>
      {(animated("x") || animated("y") || animated("scale") || animated("rotation")) && (
        <p className="qv-panel__note">
          该片段的位置/缩放带有关键帧动效：这里的数值是**当前时间点**的实际值，修改会整体平移
          （缩放则整体缩放）整条动效曲线，而不是被动画覆盖。
        </p>
      )}
      <div className="qv-grid2">
        <Field label="锚点 X">
          <Slider
            value={t.anchorX}
            min={0}
            max={1}
            onChange={(anchorX) => patch({ transform: { anchorX } })}
          />
        </Field>
        <Field label="锚点 Y">
          <Slider
            value={t.anchorY}
            min={0}
            max={1}
            onChange={(anchorY) => patch({ transform: { anchorY } })}
          />
        </Field>
      </div>
    </Section>
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function TransitionRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Clip["transitionIn"];
  onChange: (value: Clip["transitionIn"]) => void;
}) {
  const enabled = !!value;
  const easingOptions = EASING_OPTIONS.map((e) => ({ value: e, label: EASING_LABELS[e] }));
  return (
    <div className="qv-transition-row">
      <Field label={label} inline>
        <Toggle
          checked={enabled}
          onChange={(on) =>
            onChange(on ? { kind: "fade", duration: 0.5, easing: "easeOutCubic" } : undefined)
          }
        />
      </Field>
      {value && (
        <>
          <div className="qv-grid2">
            <Select
              value={value.kind}
              onChange={(kind: TransitionKind) =>
                onChange({ ...value, kind, easing: value.easing ?? "easeOutCubic" })
              }
              options={TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))}
            />
            <NumberInput
              value={value.duration}
              min={0.05}
              max={5}
              step={0.05}
              suffix="s"
              onChange={(duration) => onChange({ ...value, duration })}
            />
          </div>
          <Field label="缓动" inline>
            <Select
              value={value.easing ?? "easeOutCubic"}
              onChange={(easing: EasingName) => onChange({ ...value, easing })}
              options={easingOptions}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Motion tab
 * ------------------------------------------------------------------ */

function MotionTab({ clip }: { clip: Clip }) {
  const paths = Object.keys(clip.animation).filter((p) => clip.animation[p].length > 0);
  const localTime = Math.max(0, playback.time - clip.start);
  const easingOptions = EASING_OPTIONS.map((e) => ({ value: e, label: EASING_LABELS[e] }));

  /**
   * Rewrites one keyframe.
   *
   * Always goes through `setKeyframes`, which re-sorts: `sampleKeyframes` walks
   * the list assuming ascending time, so a keyframe dragged past its neighbour
   * would otherwise stop being sampled at all.
   */
  const editFrame = (
    path: string,
    index: number,
    patch: Partial<{ time: number; value: number | string; easing: EasingName }>,
    opts?: { history?: boolean },
  ) => {
    const frames = clip.animation[path];
    const next = frames.map((frame, i) => (i === index ? { ...frame, ...patch } : frame));
    useEditor.getState().setKeyframes(clip.id, path, next, opts);
  };

  return (
    <>
      <Section title="关键帧" collapsible={false}>
        {paths.length === 0 ? (
          <p className="qv-panel__note">
            还没有关键帧。在「基础」标签页里点击属性右侧的菱形按钮，即可在播放头位置打点。
          </p>
        ) : (
          <div className="qv-kf-list">
            {paths.map((path) => {
              const frames = clip.animation[path];
              const isColor = typeof frames[0]?.value === "string";
              return (
                <div className="qv-kf-row" key={path}>
                  <div className="qv-kf-row__head">
                    <span className="qv-kf-row__path">{path}</span>
                    <div className="qv-kf-row__tools">
                      <IconButton
                        icon={<Diamond size={12} />}
                        title="在当前播放头位置插入关键帧"
                        onClick={() =>
                          useEditor.getState().updateClip(clip.id, (current) => {
                            const existing = current.animation[path] ?? [];
                            if (existing.some((f) => Math.abs(f.time - localTime) < 1 / 60)) return current;
                            const value = currentValue(current, path, localTime);
                            const frame: Keyframe = {
                              time: localTime,
                              value: typeof value === "number" || typeof value === "string" ? value : 0,
                              easing: "easeInOutCubic",
                            };
                            return {
                              ...current,
                              animation: {
                                ...current.animation,
                                [path]: [...existing, frame].sort((a, b) => a.time - b.time),
                              },
                            };
                          })
                        }
                      />
                      <IconButton
                        icon={<Trash2 size={12} />}
                        title="清除该属性的全部关键帧"
                        danger
                        onClick={() => useEditor.getState().clearAnimation(clip.id, path)}
                      />
                    </div>
                  </div>

                  <div className="qv-kf-items">
                    {frames.map((frame, index) => (
                      <div className="qv-kf-item" key={`${path}-${index}`}>
                        <div className="qv-kf-item__row">
                          <button
                            type="button"
                            className="qv-kf-item__seek"
                            title="跳到该关键帧"
                            onClick={() => playback.seek(clip.start + frame.time)}
                          >
                            <SkipForward size={11} />
                          </button>
                          <NumberInput
                            value={frame.time}
                            min={0}
                            max={clip.duration}
                            step={1 / 30}
                            precision={2}
                            suffix="s"
                            onChange={(time) =>
                              editFrame(path, index, {
                                time: Math.max(0, Math.min(clip.duration, time)),
                              })
                            }
                          />
                          {isColor ? (
                            <ColorInput
                              value={String(frame.value)}
                              onChange={(value) => {
                                const store = useEditor.getState();
                                if (!store.pendingSnapshot) store.beginHistory();
                                editFrame(path, index, { value }, { history: false });
                              }}
                              onCommit={() => useEditor.getState().endHistory()}
                            />
                          ) : (
                            <NumberInput
                              value={Number(frame.value)}
                              step={1}
                              precision={2}
                              onChange={(value) => editFrame(path, index, { value })}
                            />
                          )}
                          <IconButton
                            icon={<Trash2 size={12} />}
                            title="删除该关键帧"
                            danger
                            onClick={() =>
                              useEditor
                                .getState()
                                .setKeyframes(
                                  clip.id,
                                  path,
                                  frames.filter((_, i) => i !== index),
                                )
                            }
                          />
                        </div>
                        <Select
                          value={frame.easing}
                          onChange={(easing: EasingName) => editFrame(path, index, { easing })}
                          options={easingOptions}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="qv-kf-row__hint">
                    共 {frames.length} 个关键帧 · 曲线作用在「进入该关键帧」的那一段上
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="快捷" collapsible={false}>
        <div className="qv-quick-grid">
          <Button
            variant="default"
            onClick={() =>
              useEditor.getState().updateClip(clip.id, {
                animation: {
                  ...clip.animation,
                  opacity: [
                    { time: localTime, value: 0, easing: "linear" },
                    { time: localTime + 0.6, value: 1, easing: "easeOutCubic" },
                  ],
                },
              })
            }
          >
            淡入 (0.6s)
          </Button>
          <Button
            variant="default"
            onClick={() =>
              useEditor.getState().updateClip(clip.id, {
                animation: {
                  ...clip.animation,
                  "transform.y": [
                    { time: localTime, value: clip.transform.y + 60, easing: "linear" },
                    { time: localTime + 0.75, value: clip.transform.y, easing: "easeOutQuart" },
                  ],
                },
              })
            }
          >
            上浮进入
          </Button>
          <Button
            variant="default"
            onClick={() =>
              useEditor.getState().updateClip(clip.id, {
                animation: {
                  ...clip.animation,
                  "transform.scale": [
                    { time: localTime, value: clip.transform.scale * 0.85, easing: "linear" },
                    { time: localTime + 0.65, value: clip.transform.scale, easing: "easeOutBack" },
                  ],
                },
              })
            }
          >
            弹出缩放
          </Button>
          <Button
            variant="default"
            onClick={() => playback.seek(clip.start)}
          >
            跳到片段开头
          </Button>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Effects tab
 * ------------------------------------------------------------------ */

const FILTER_PRESETS: { label: string; filters: FilterState }[] = [
  {
    label: "原始",
    filters: { ...DEFAULT_FILTERS },
  },
  {
    label: "暖色",
    filters: {
      ...DEFAULT_FILTERS,
      brightness: 1.08,
      saturate: 1.2,
      hueRotate: 12,
      contrast: 1.05,
    },
  },
  {
    label: "冷色",
    filters: {
      ...DEFAULT_FILTERS,
      brightness: 1.02,
      saturate: 0.9,
      hueRotate: -14,
      contrast: 1.05,
    },
  },
  {
    label: "复古",
    filters: {
      ...DEFAULT_FILTERS,
      brightness: 0.92,
      contrast: 0.88,
      saturate: 0.7,
      hueRotate: 20,
      grayscale: 0.25,
    },
  },
  {
    label: "黑白",
    filters: {
      ...DEFAULT_FILTERS,
      grayscale: 1,
      contrast: 1.1,
    },
  },
  {
    label: "高对比",
    filters: {
      ...DEFAULT_FILTERS,
      contrast: 1.45,
      brightness: 1.05,
      saturate: 1.1,
    },
  },
  {
    label: "柔焦",
    filters: {
      ...DEFAULT_FILTERS,
      blur: 2.5,
      brightness: 1.08,
      saturate: 1.05,
    },
  },
  {
    label: "电影感",
    filters: {
      ...DEFAULT_FILTERS,
      contrast: 1.18,
      saturate: 0.82,
      brightness: 0.96,
      hueRotate: -6,
    },
  },
];

function EffectsTab({ clip }: { clip: Clip }) {
  const filters = clip.filters;
  const patch = (patch: Parameters<ReturnType<typeof useEditor.getState>["updateClip"]>[1]) =>
    useEditor.getState().updateClip(clip.id, patch);
  const patchLive = (p: Parameters<ReturnType<typeof useEditor.getState>["updateClip"]>[1]) => {
    const store = useEditor.getState();
    if (!store.pendingSnapshot) store.beginHistory();
    store.updateClip(clip.id, p, { history: false });
  };
  const commitLive = () => useEditor.getState().endHistory();

  const filtersEqual = (a: FilterState, b: FilterState) =>
    a.blur === b.blur &&
    a.brightness === b.brightness &&
    a.contrast === b.contrast &&
    a.saturate === b.saturate &&
    a.grayscale === b.grayscale &&
    a.hueRotate === b.hueRotate &&
    a.shadowBlur === b.shadowBlur &&
    a.shadowX === b.shadowX &&
    a.shadowY === b.shadowY &&
    a.shadowColor === b.shadowColor;

  return (
    <>
      <div className="qv-filter-presets">
        {FILTER_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={
              filtersEqual(filters, preset.filters)
                ? "qv-filter-presets__btn qv-filter-presets__btn--on"
                : "qv-filter-presets__btn"
            }
            onClick={() => patch({ filters: { ...preset.filters } })}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <Section title="颜色调整" collapsible={false}>
        <KeySlider
          clip={clip}
          path="filters.blur"
          label="模糊"
          min={0}
          max={60}
          step={0.5}
          precision={1}
          hint="可打关键帧；「清单聚焦」那种虚化靠它"
        />
        <Field label="亮度">
          <Slider
            value={filters.brightness}
            min={0}
            max={2.5}
            step={0.01}
            onChange={(brightness) => patch({ filters: { brightness } })}
          />
        </Field>
        <Field label="对比度">
          <Slider
            value={filters.contrast}
            min={0}
            max={2.5}
            step={0.01}
            onChange={(contrast) => patch({ filters: { contrast } })}
          />
        </Field>
        <Field label="饱和度">
          <Slider
            value={filters.saturate}
            min={0}
            max={3}
            step={0.01}
            onChange={(saturate) => patch({ filters: { saturate } })}
          />
        </Field>
        <Field label="去色">
          <Slider
            value={filters.grayscale}
            min={0}
            max={1}
            onChange={(grayscale) => patch({ filters: { grayscale } })}
          />
        </Field>
        <Field label="色相旋转">
          <Slider
            value={filters.hueRotate}
            min={-180}
            max={180}
            step={1}
            precision={0}
            onChange={(hueRotate) => patch({ filters: { hueRotate } })}
          />
        </Field>
      </Section>

      <Section title="投影" defaultOpen={false}>
        <Field label="模糊">
          <Slider
            value={filters.shadowBlur}
            min={0}
            max={120}
            step={1}
            precision={0}
            onChange={(shadowBlur) => patch({ filters: { shadowBlur } })}
          />
        </Field>
        <div className="qv-grid2">
          <Field label="X 偏移">
            <NumberInput
              value={filters.shadowX}
              step={1}
              suffix="px"
              onChange={(shadowX) => patch({ filters: { shadowX } })}
            />
          </Field>
          <Field label="Y 偏移">
            <NumberInput
              value={filters.shadowY}
              step={1}
              suffix="px"
              onChange={(shadowY) => patch({ filters: { shadowY } })}
            />
          </Field>
        </div>
        <Field label="颜色">
          <ColorInput
            value={filters.shadowColor}
            onChange={(shadowColor) => patchLive({ filters: { shadowColor } })}
            onCommit={commitLive}
          />
        </Field>
      </Section>

      <div className="qv-inspector__foot">
        <Button
          variant="ghost"
          onClick={() =>
            patch({
              filters: {
                blur: 0,
                brightness: 1,
                contrast: 1,
                saturate: 1,
                grayscale: 0,
                hueRotate: 0,
                shadowBlur: 0,
                shadowX: 0,
                shadowY: 0,
                shadowColor: "rgba(0,0,0,0.45)",
              },
            })
          }
        >
          重置效果
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Template slots
 * ------------------------------------------------------------------ */

function TemplateInspector({ templateId }: { templateId: string }) {
  const project = useEditor((s) => s.project);
  const template = getTemplate(templateId);

  if (!template) {
    return (
      <div className="qv-inspector__empty">
        <p className="qv-panel__note">
          当前工程来自模板「{templateId}」，但该模板已不在内置列表中，因此无法再参数化重建。
          可以直接选中时间线上的片段逐个调整。
        </p>
      </div>
    );
  }

  const groups = new Map<string, TemplateSlot[]>();
  for (const slot of template.slots) {
    const key = slot.group ?? "参数";
    const bucket = groups.get(key);
    if (bucket) bucket.push(slot);
    else groups.set(key, [slot]);
  }

  const onSlotChange = (slot: TemplateSlot, value: SlotValue) => {
    const state = useEditor.getState();
    state.setSlot(slot.id, value, (draft) =>
      buildFromTemplate(template, draft.slots, draft.assets),
    );
  };
  const onSlotChangeLive = (slot: TemplateSlot, value: SlotValue) => {
    const state = useEditor.getState();
    if (!state.pendingSnapshot) state.beginHistory();
    state.setSlot(
      slot.id,
      value,
      (draft) => buildFromTemplate(template, draft.slots, draft.assets),
      { history: false },
    );
  };
  const onSlotCommit = () => useEditor.getState().endHistory();

  return (
    <>
      <div className="qv-tpl-head">
        <Sparkles size={15} />
        <div>
          <div className="qv-tpl-head__name">{template.name}</div>
          <div className="qv-tpl-head__meta">
            {template.aspect} · {template.duration}s · 共 {template.slots.length} 项参数
          </div>
        </div>
      </div>

      <p className="qv-panel__note">
        修改任意参数都会按模板重新生成整条时间线，手工拖动过的片段会被覆盖。
      </p>

      {Array.from(groups.entries()).map(([group, slots]) => (
        <Section title={group} key={group} defaultOpen>
          {slots.map((slot) => (
            <SlotField
              key={slot.id}
              slot={slot}
              value={project.slots[slot.id] ?? slot.default}
              assets={project.assets}
              onChange={(value) => onSlotChange(slot, value)}
              onChangeLive={(value) => onSlotChangeLive(slot, value)}
              onCommit={onSlotCommit}
            />
          ))}
        </Section>
      ))}
    </>
  );
}

function SlotField({
  slot,
  value,
  assets,
  onChange,
  onChangeLive,
  onCommit,
}: {
  slot: TemplateSlot;
  value: SlotValue;
  assets: Array<{ id: string; name: string; kind: string }>;
  onChange: (value: SlotValue) => void;
  onChangeLive?: (value: SlotValue) => void;
  onCommit?: () => void;
}) {
  if (slot.type === "list") {
    const records = Array.isArray(value) ? (value as SlotRecord[]) : [];
    return (
      <Field label={slot.label} hint={slot.help}>
        <SlotListInput
          slot={slot}
          records={records}
          assets={assets}
          onChange={(next) => onChange(next as SlotValue)}
        />
      </Field>
    );
  }

  return (
    <Field label={slot.label} hint={slot.help}>
      <SlotFieldBody
        slot={slot}
        value={value}
        assets={assets}
        onChange={onChange}
        onChangeLive={onChangeLive}
        onCommit={onCommit}
      />
    </Field>
  );
}

/** 一格输入的**裸控件**（不含 `Field` 外壳），这样列表条目里也能嵌。 */
function SlotFieldBody({
  slot,
  value,
  assets,
  onChange,
  onChangeLive,
  onCommit,
}: {
  slot: TemplateSlot;
  value: SlotValue;
  assets: Array<{ id: string; name: string; kind: string }>;
  onChange: (value: SlotValue) => void;
  onChangeLive?: (value: SlotValue) => void;
  onCommit?: () => void;
}) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const number = typeof value === "number" ? value : Number(value) || 0;

  switch (slot.type) {
    case "textarea":
      return <TextInput value={text} onChange={onChange} multiline />;
    case "color":
      return (
        <ColorInput
          value={text}
          onChange={(v) => (onChangeLive ? onChangeLive(v) : onChange(v))}
          onCommit={onCommit}
        />
      );
    case "number":
      return (
        <NumberInput
          value={number}
          min={slot.min}
          max={slot.max}
          step={slot.step ?? 1}
          onChange={onChange}
        />
      );
    case "boolean":
      return <Toggle checked={value === true} onChange={onChange} />;
    case "select":
      return (
        <Select
          value={text}
          onChange={onChange}
          options={(slot.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
      );
    case "asset": {
      const media = assets.filter((a) => !slot.assetKind || a.kind === slot.assetKind);
      return (
        <Select
          value={text}
          onChange={onChange}
          options={[
            { value: "", label: "（自动选择）" },
            ...media.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
      );
    }
    case "list": {
      const records = Array.isArray(value) ? (value as SlotRecord[]) : [];
      return (
        <SlotListInput
          slot={slot}
          records={records}
          assets={assets}
          onChange={(next) => onChange(next as SlotValue)}
        />
      );
    }
    default:
      return <TextInput value={text} onChange={onChange} />;
  }
}

/**
 * 可增删的条目列表。
 *
 * 每一个条目就是一组 `Schema.fields`，字段本身仍走 `SlotFieldBody`，所以条目里
 * 可以有文字、有配图、也可以再嵌一层列表——表单只写一遍，深度随便加。
 *
 * 数组用**整体替换**的方式回写（`onChange(next)`），不做原地修改：插槽值是工程的
 * 存档数据，原地改会让撤销栈拿到同一个数组引用。
 */
function SlotListInput({
  slot,
  records,
  assets,
  onChange,
}: {
  slot: TemplateSlot;
  records: SlotRecord[];
  assets: Array<{ id: string; name: string; kind: string }>;
  onChange: (next: SlotRecord[]) => void;
}) {
  const schema = slot.item;
  if (!schema) return null;
  const max = schema.max ?? 99;

  const replace = (index: number, next: SlotRecord) =>
    onChange(records.map((r, i) => (i === index ? next : r)));
  const remove = (index: number) => onChange(records.filter((_, i) => i !== index));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= records.length) return;
    const next = [...records];
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry);
    onChange(next);
  };
  const append = () => {
    // 新条目从 schema 的默认值开始，用户一加就有内容可看。
    const blank: SlotRecord = {};
    for (const field of schema.fields) blank[field.id] = field.default as SlotRecord[string];
    onChange([...records, blank]);
  };

  return (
    <div className="qv-list">
      {records.map((record, index) => (
        <div className="qv-list__item" key={index}>
          <div className="qv-list__head">
            <span className="qv-list__index">{index + 1}</span>
            <div className="qv-list__tools">
              <button
                type="button"
                className="qv-list__tool"
                title="上移"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronDown size={13} className="qv-list__up" />
              </button>
              <button
                type="button"
                className="qv-list__tool"
                title="下移"
                disabled={index === records.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className="qv-list__tool qv-list__tool--danger"
                title="删除这一项"
                onClick={() => remove(index)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {schema.fields.map((field) => (
            <Field label={field.label} hint={field.help} key={field.id}>
              <SlotFieldBody
                slot={field}
                value={(record[field.id] ?? field.default) as SlotValue}
                assets={assets}
                onChange={(value) => replace(index, { ...record, [field.id]: value as never })}
              />
            </Field>
          ))}
        </div>
      ))}

      <div className="qv-list__foot">
        <Button
          variant="ghost"
          onClick={append}
          disabled={records.length >= max}
          title={records.length >= max ? `最多 ${max} 项` : undefined}
        >
          <Plus size={13} />
          {schema.addLabel ?? "添加一项"}
        </Button>
        <span className="qv-list__count">
          {records.length}/{max}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Project settings
 * ------------------------------------------------------------------ */

function ProjectInspector() {
  const project = useEditor((s) => s.project);
  const updateSettings = useEditor((s) => s.updateSettings);
  const renameProject = useEditor((s) => s.renameProject);
  const settings = project.settings;

  const updateSettingsLive = (patch: Partial<typeof settings>) => {
    const store = useEditor.getState();
    if (!store.pendingSnapshot) store.beginHistory();
    store.updateSettings(patch, { history: false });
  };
  const commitLive = () => useEditor.getState().endHistory();

  const aspectOptions: Array<Option<typeof settings.aspect>> = [
    { value: "16:9", label: "16:9 横屏" },
    { value: "9:16", label: "9:16 竖屏" },
    { value: "1:1", label: "1:1 方形" },
    { value: "4:5", label: "4:5 社媒" },
    { value: "21:9", label: "21:9 宽银幕" },
  ];

  const presetSizes: Record<string, { width: number; height: number }> = {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 },
    "4:5": { width: 1080, height: 1350 },
    "21:9": { width: 2560, height: 1080 },
  };

  return (
    <>
      <div className="qv-tpl-head">
        <div>
          <div className="qv-tpl-head__name">工程设置</div>
          <div className="qv-tpl-head__meta">
            时长 {effectiveDuration(project).toFixed(1)}s ·{" "}
            {project.tracks.reduce((n, t) => n + t.clips.length, 0)} 个片段
          </div>
        </div>
      </div>

      <Section title="基本信息" collapsible={false}>
        <Field label="工程名称">
          <TextInput value={project.name} onChange={renameProject} />
        </Field>
        <Field label="画幅">
          <Select
            value={settings.aspect}
            onChange={(aspect) => updateSettings({ aspect, ...presetSizes[aspect] })}
            options={aspectOptions}
          />
        </Field>
        <div className="qv-grid2">
          <Field label="宽">
            <NumberInput
              value={settings.width}
              min={64}
              max={7680}
              step={2}
              onChange={(width) => updateSettings({ width })}
            />
          </Field>
          <Field label="高">
            <NumberInput
              value={settings.height}
              min={64}
              max={7680}
              step={2}
              onChange={(height) => updateSettings({ height })}
            />
          </Field>
        </div>
        <div className="qv-grid2">
          <Field label="帧率">
            <Select
              value={String(settings.fps)}
              onChange={(fps) => updateSettings({ fps: Number(fps) })}
              options={[
                { value: "24", label: "24 fps" },
                { value: "25", label: "25 fps" },
                { value: "30", label: "30 fps" },
                { value: "50", label: "50 fps" },
                { value: "60", label: "60 fps" },
                { value: "100", label: "100 fps" },
                { value: "120", label: "120 fps" },
              ]}
            />
          </Field>
          {/*
            Read-only: the timeline now ends where the content ends, so an
            editable total length would be a control that lies about what will
            be exported.
          */}
          <div className="qv-kv">
            <span>时间线时长</span>
            <span>{formatDuration(effectiveDuration(project))}（跟随片段）</span>
          </div>
        </div>
        <Field label="背景色">
          <ColorInput
            value={settings.background}
            onChange={(background) => updateSettingsLive({ background })}
            onCommit={commitLive}
          />
        </Field>
      </Section>

      <Section title="外观主题" collapsible={false}>
        <Field label="预设">
          <Select
            value={Object.keys(BUILT_IN_THEMES).find((k) => BUILT_IN_THEMES[k] === project.theme) ?? "presentation"}
            onChange={(key) =>
              useEditor.getState().commit((p) => ({ ...p, theme: BUILT_IN_THEMES[key] }))
            }
            options={Object.keys(BUILT_IN_THEMES).map((key) => ({
              value: key,
              label: THEME_LABELS[key] ?? key,
            }))}
          />
        </Field>
        <Field label="主色">
          <ColorInput
            value={project.theme.accent}
            onChange={(accent) => {
              const store = useEditor.getState();
              if (!store.pendingSnapshot) store.beginHistory();
              store.commit((p) => ({ ...p, theme: { ...p.theme, accent } }), { history: false });
            }}
            onCommit={() => useEditor.getState().endHistory()}
          />
        </Field>
      </Section>
    </>
  );
}
