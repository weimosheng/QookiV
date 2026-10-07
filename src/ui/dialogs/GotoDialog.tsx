import { useState } from "react";
import { playback } from "../../engine/PlaybackEngine";
import { Button, Modal, TextInput } from "../controls";

/**
 * Jump-to-timecode dialog. Accepts seconds (`12.5`), `MM:SS`, `HH:MM:SS`, or
 * `HH:MM:SS.ms` — the formats a timecode readout actually shows.
 */
export function GotoDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const t = parseTimecode(value);
    if (t === null) {
      setError("无法解析，例：12.5、00:12、00:00:12.5");
      return;
    }
    playback.pause();
    playback.seek(t);
    onClose();
  };

  return (
    <Modal
      title="跳到时间码"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            跳转
          </Button>
        </>
      }
    >
      <div className="qv-goto">
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(null);
          }}
          placeholder="00:00:12.5 或 12.5"
        />
        {error && <div className="qv-goto__error">{error}</div>}
        <div className="qv-goto__hint">
          当前 {playback.time.toFixed(2)}s · 总时长 {playback.duration.toFixed(2)}s
        </div>
      </div>
    </Modal>
  );
}

function parseTimecode(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const parts = v.split(":").map((p) => p.trim());
  if (parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    const nums = parts.map(Number);
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / 1000;
  }
  return null;
}
