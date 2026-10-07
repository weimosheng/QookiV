import { useEffect, useRef, useState } from "react";
import { effectiveDuration } from "../../core/time";
import { thumbnailPool } from "../../engine/sharedPool";
import { Renderer } from "../../render/Renderer";
import { buildFromTemplate } from "../../templates/apply";
import { searchTemplates } from "../../templates/registry";
import { defaultSlotValues } from "../../templates/types";
import type { PromoTemplate } from "../../templates/types";
import { useEditor } from "../../store/editorStore";
import { Button, EmptyState, TextInput } from "../controls";
import { Sparkles, Wand2 } from "../icons";

/**
 * Template gallery.
 *
 * Each card renders a real frame from its own template through the same
 * compositor the editor uses, so the thumbnail is an honest preview rather than
 * a hand-drawn mock. Rendering happens on a separate media pool to avoid
 * disturbing the timeline's decoded media.
 */
export function TemplateGallery() {
  const [query, setQuery] = useState("");
  const results = searchTemplates(query);
  const assets = useEditor((s) => s.project.assets);

  return (
    <div className="qv-panel__scroll">
      <div className="qv-panel__actions">
        <TextInput value={query} onChange={setQuery} placeholder="搜索模板…" />
        <p className="qv-panel__note">
          套用模板会按当前素材库重新生成整条时间线，之后可以在检查器里逐项修改文案与配色。
        </p>
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={26} />}
          title="没有匹配的模板"
          hint="换个关键词试试，或清空搜索框查看全部模板。"
        />
      ) : (
        <div className="qv-gallery">
          {results.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              assetCount={assets.length}
              onApply={() => applyTemplate(template)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function applyTemplate(template: PromoTemplate): void {
  const state = useEditor.getState();
  const values = defaultSlotValues(template);
  const built = buildFromTemplate(template, values, state.project.assets);
  // Keep the current project name — a template swap must not rename the project.
  state.applyTemplateProject({ ...built, name: state.project.name }, template.id, values);
}

function TemplateCard({
  template,
  assetCount,
  onApply,
}: {
  template: PromoTemplate;
  assetCount: number;
  onApply: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  const thumbW = 300;
  const thumbH = Math.round((thumbW * 9) / 16);

  useEffect(() => {
    let cancelled = false;

    const project = buildFromTemplate(template, defaultSlotValues(template), []);
    thumbnailPool.sync(project.assets);

    const scratch = document.createElement("canvas");
    scratch.width = project.settings.width;
    scratch.height = project.settings.height;

    const draw = () => {
      if (cancelled) return;
      const target = canvasRef.current;
      if (!target) return;
      const sctx = scratch.getContext("2d");
      const tctx = target.getContext("2d");
      if (!sctx || !tctx) return;

      // A point a little past the middle usually lands on a content-rich frame.
      const time = Math.min(effectiveDuration(project) * 0.55, template.duration * 0.55);
      new Renderer(project, thumbnailPool).renderFrame(sctx, time, { quality: "preview" });
      tctx.clearRect(0, 0, target.width, target.height);
      tctx.drawImage(scratch, 0, 0, target.width, target.height);
      setReady(true);
    };

    draw();
    // Bundled logos load asynchronously; redraw once they are in.
    const timers = [window.setTimeout(draw, 220), window.setTimeout(draw, 800)];
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [template]);

  const ratio = template.aspect === "9:16" ? "9 / 16" : template.aspect === "1:1" ? "1 / 1" : "16 / 9";

  return (
    <div className="qv-card">
      <div className="qv-card__thumb" style={{ aspectRatio: ratio }}>
        <canvas
          ref={canvasRef}
          width={template.aspect === "9:16" ? 260 : thumbW}
          height={template.aspect === "9:16" ? 462 : thumbH}
          className={ready ? "qv-card__canvas qv-card__canvas--on" : "qv-card__canvas"}
        />
        <span className="qv-card__aspect">{template.aspect}</span>
        <span className="qv-card__duration">{template.duration}s</span>
      </div>

      <div className="qv-card__body">
        <div className="qv-card__title">{template.name}</div>
        <div className="qv-card__desc">{template.description}</div>
        <div className="qv-card__tags">
          {template.tags.map((tag) => (
            <span className="qv-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="qv-card__foot">
        <Button variant="primary" icon={<Wand2 size={14} />} onClick={onApply} full>
          套用模板
        </Button>
        {assetCount === 0 && template.tags.includes("界面演示") && (
          <div className="qv-card__hint">导入截图后会自动填入演示窗口</div>
        )}
      </div>
    </div>
  );
}
