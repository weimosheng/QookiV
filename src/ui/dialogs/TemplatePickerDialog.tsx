import { useEffect, useRef, useState } from "react";
import { effectiveDuration } from "../../core/time";
import { thumbnailPool } from "../../engine/sharedPool";
import { Renderer } from "../../render/Renderer";
import { buildFromTemplate } from "../../templates/apply";
import { CATEGORY_LABELS, groupTemplates } from "../../templates/registry";
import { defaultSlotValues } from "../../templates/types";
import type { PromoTemplate } from "../../templates/types";
import { Modal } from "../controls";

/**
 * Template picker shown when the user asks for a new project. Picking a template
 * is the mandatory first step — there is no "blank project" entry, because every
 * QookiV project is built from a template.
 *
 * 每张卡片用 Canvas 实时渲染模板中点帧作为预览，和左侧面板的模板画廊同一套管线
 * （`thumbnailPool` + `Renderer`），只是这里点选后直接进编辑器而非套用到当前工程。
 */
export function TemplatePickerDialog({
  onPick,
  onClose,
}: {
  onPick: (template: PromoTemplate) => void;
  onClose: () => void;
}) {
  const groups = groupTemplates();

  return (
    <Modal title="选择模板开始新项目" onClose={onClose} width={900}>
      <div className="qv-tpicker">
        {groups.map((group) => (
          <div className="qv-tpicker__group" key={group.category}>
            <div className="qv-tpicker__label">{group.label}</div>
            <div className="qv-tpicker__grid">
              {group.templates.map((t) => (
                <TemplatePickCard key={t.id} template={t} onPick={() => onPick(t)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function TemplatePickCard({
  template,
  onPick,
}: {
  template: PromoTemplate;
  onPick: () => void;
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

      const time = Math.min(effectiveDuration(project) * 0.55, template.duration * 0.55);
      new Renderer(project, thumbnailPool).renderFrame(sctx, time, { quality: "preview" });
      tctx.clearRect(0, 0, target.width, target.height);
      tctx.drawImage(scratch, 0, 0, target.width, target.height);
      setReady(true);
    };

    draw();
    const timers = [window.setTimeout(draw, 220), window.setTimeout(draw, 800)];
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [template]);

  const ratio = template.aspect === "9:16" ? "9 / 16" : template.aspect === "1:1" ? "1 / 1" : "16 / 9";

  return (
    <div
      className="qv-tpicker__card"
      onClick={onPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <div className="qv-tpicker__thumb" style={{ aspectRatio: ratio }}>
        <canvas
          ref={canvasRef}
          width={template.aspect === "9:16" ? 260 : thumbW}
          height={template.aspect === "9:16" ? 462 : thumbH}
          className={ready ? "qv-tpicker__canvas qv-tpicker__canvas--on" : "qv-tpicker__canvas"}
        />
        <span className="qv-tpicker__chip">{template.aspect}</span>
        <span className="qv-tpicker__chip qv-tpicker__chip--dur">{template.duration}s</span>
      </div>
      <div className="qv-tpicker__body">
        <div className="qv-tpicker__name" title={template.name}>
          {template.name}
        </div>
        <div className="qv-tpicker__desc">{template.description}</div>
        <div className="qv-tpicker__tags">
          {template.tags.map((tag) => (
            <span className="qv-tpicker__tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        <div className="qv-tpicker__cat">{CATEGORY_LABELS[template.category]}</div>
      </div>
    </div>
  );
}
