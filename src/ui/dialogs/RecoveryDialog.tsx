import { effectiveDuration, formatDuration } from "../../core/time";
import type { Project } from "../../core/types";
import { Button, Modal } from "../controls";
import { AlertCircle } from "../icons";

/**
 * Offered at startup when a previous session ended with unsaved work.
 *
 * Deliberately blocking: the alternative is silently discarding someone's edit,
 * and the dialog states exactly what is at stake so the choice is easy.
 */
export function RecoveryDialog({
  project,
  filePath,
  savedAt,
  onRestore,
  onDiscard,
}: {
  project: Project;
  filePath: string | null;
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const clips = project.tracks.reduce((total, track) => total + track.clips.length, 0);
  const assets = project.assets.length;
  const stamp = new Date(savedAt);

  return (
    <Modal
      title="发现未保存的工作"
      onClose={onDiscard}
      width={470}
      footer={
        <>
          <Button variant="ghost" onClick={onDiscard}>
            丢弃
          </Button>
          <Button variant="primary" onClick={onRestore}>
            恢复
          </Button>
        </>
      }
    >
      <div className="qv-alert qv-alert--warn">
        <AlertCircle size={14} />
        <div>
          上次使用 QookiV 时还有未保存的修改。恢复后可以继续编辑，再自己决定存到哪里。
        </div>
      </div>

      <div className="qv-kv">
        <span>工程名称</span>
        <span>{project.name}</span>
      </div>
      <div className="qv-kv">
        <span>最后自动保存</span>
        <span>{stamp.toLocaleString()}</span>
      </div>
      <div className="qv-kv">
        <span>内容</span>
        <span>
          {clips} 个片段 · {assets} 个素材 · 约 {formatDuration(effectiveDuration(project))}
        </span>
      </div>
      <div className="qv-kv">
        <span>原保存位置</span>
        <span>{filePath ?? "尚未保存到文件"}</span>
      </div>

      <p className="qv-panel__note">
        自动保存只在「有未保存修改」时写入，因此这个提示出现，就意味着上次退出时确实丢了东西。
      </p>
    </Modal>
  );
}
