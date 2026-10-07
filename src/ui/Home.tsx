import { useState } from "react";
import type { RecentProject } from "../services/recentProjects";
import { Button, EmptyState } from "./controls";
import { Clock, Film, Plus, Trash2 } from "./icons";

/**
 * Start page — the first thing the app shows. A "new project" entry and a
 * recent-projects grid, like CapCut/JianYing's home. Creating a project opens
 * a template picker dialog rather than dropping straight into the editor.
 */
export function Home({
  recents,
  onOpen,
  onNewProject,
  onRemoveRecent,
}: {
  recents: RecentProject[];
  onOpen: (path: string) => void;
  onNewProject: () => void;
  onRemoveRecent: (path: string) => void;
}) {
  return (
    <div className="qv-home">
      <section className="qv-home__hero">
        <h1 className="qv-home__title">开始创作</h1>
        <p className="qv-home__sub">选择模板开始一个新工程，或从最近项目继续编辑。</p>
        <div className="qv-home__actions">
          <Button variant="primary" icon={<Plus size={15} />} onClick={onNewProject}>
            新建项目
          </Button>
        </div>
      </section>

      <section className="qv-home__section">
        <header className="qv-home__head">
          <h2>
            <Clock size={16} /> 最近项目
          </h2>
          {recents.length > 0 && <span className="qv-home__count">{recents.length} 个</span>}
        </header>

        {recents.length === 0 ? (
          <EmptyState
            icon={<Film size={28} />}
            title="还没有最近项目"
            hint="点击上方「新建项目」选择一个模板开始，保存后会出现在这里。"
          />
        ) : (
          <div className="qv-home__grid">
            {recents.map((r) => (
              <RecentCard
                key={r.path}
                record={r}
                onOpen={() => onOpen(r.path)}
                onRemove={() => onRemoveRecent(r.path)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RecentCard({
  record,
  onOpen,
  onRemove,
}: {
  record: RecentProject;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  const hue = hashHue(record.name);
  const initial = record.name.trim().charAt(0) || "·";

  return (
    <div
      className="qv-home__card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div
        className="qv-home__thumb"
        style={
          record.thumbnail
            ? { backgroundImage: `url(${record.thumbnail})` }
            : {
                backgroundImage: `linear-gradient(135deg, hsl(${hue}, 42%, 22%), hsl(${(hue + 48) % 360}, 46%, 30%))`,
              }
        }
      >
        {!record.thumbnail && <span className="qv-home__initial">{initial}</span>}
        {hover && (
          <button
            className="qv-home__remove"
            title="从列表移除"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="qv-home__meta">
        <div className="qv-home__name" title={record.name}>
          {record.name}
        </div>
        <div className="qv-home__time">
          {relativeTime(record.savedAt)}
          {record.duration !== undefined && <> · {record.duration.toFixed(1)}s</>}
        </div>
      </div>
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return (h + 360) % 360;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString();
}
