import { useEffect, useRef, useState } from "react";
import { Pencil } from "./icons";

/**
 * The project title in the titlebar, editable in place.
 *
 * Click to edit, Enter or blur to commit, Escape to cancel. An empty name is
 * rejected rather than stored: the name becomes the default file name for the
 * video, the HTML export and the project file, and an empty one would produce
 * ".mp4" and "." on disk.
 */
export function EditableTitle({
  name,
  dirty,
  onRename,
}: {
  name: string;
  dirty: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in step when the name changes from elsewhere (open, template).
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) onRename(next);
    else setDraft(name);
  };

  if (editing) {
    return (
      <span className="qv-doc qv-doc--editing">
        <input
          ref={inputRef}
          className="qv-doc__input"
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // The shell binds single-letter shortcuts; they must not fire while
            // typing a name.
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="qv-doc qv-doc--button"
      title="点击修改作品名称（会用作导出文件的默认文件名）"
      onClick={() => setEditing(true)}
    >
      <span className="qv-doc__text">{name}</span>
      <Pencil size={11} className="qv-doc__pencil" />
      {dirty && <span className="qv-doc__dot" title="有未保存的修改" />}
    </button>
  );
}
