import { Modal } from "../controls";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "播放",
    items: [
      ["Space", "播放 / 暂停"],
      ["J / K / L", "倒放 / 暂停 / 正放"],
      ["← / →", "逐帧步进"],
      ["Shift + ← / →", "秒级步进"],
      ["↑ / ↓", "跳到选区起止 / 上下编辑点"],
      ["Home / End", "跳到时间线首尾"],
    ],
  },
  {
    title: "标记",
    items: [
      ["I / Shift+I", "设置 / 清除入点"],
      ["O / Shift+O", "设置 / 清除出点"],
    ],
  },
  {
    title: "编辑",
    items: [
      ["S", "在播放头分割"],
      ["Delete", "删除所选片段（留空隙）"],
      ["Shift+Delete", "波纹删除（后续片段前移）"],
      ["Ctrl+Delete", "清空当前轨道"],
      ["Ctrl+Shift+Delete", "删除当前轨道"],
      ["Ctrl+D", "就地复制"],
      ["Ctrl+C / X / V", "复制 / 剪切 / 粘贴"],
      ["Ctrl+A", "全选"],
      ["Esc", "清空选区"],
    ],
  },
  {
    title: "视图",
    items: [
      ["+ / -", "时间线缩放"],
      ["F", "适配时间线到窗口"],
      ["Shift+Z", "缩放到所选片段"],
      ["F11", "预览全屏"],
    ],
  },
  {
    title: "工程",
    items: [
      ["Ctrl+N", "新建工程"],
      ["Ctrl+O", "打开工程"],
      ["Ctrl+S / Shift+Ctrl+S", "保存 / 另存为"],
      ["Ctrl+Z / Shift+Ctrl+Z", "撤销 / 重做"],
      ["Ctrl+Y", "重做"],
      ["Ctrl+G", "跳到时间码"],
    ],
  },
  {
    title: "导出",
    items: [
      ["Ctrl+E", "导出视频"],
      ["Shift+Ctrl+E", "导出网页"],
      ["Shift+Ctrl+F", "导出当前帧 PNG"],
    ],
  },
  {
    title: "帮助",
    items: [["F1 / ?", "快捷键帮助"]],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="快捷键" onClose={onClose} width={560}>
      <div className="qv-shortcuts">
        {GROUPS.map((g) => (
          <div className="qv-shortcuts__group" key={g.title}>
            <div className="qv-shortcuts__title">{g.title}</div>
            <table className="qv-shortcuts__table">
              <tbody>
                {g.items.map(([key, desc]) => (
                  <tr key={key}>
                    <td className="qv-shortcuts__key">
                      <kbd>{key}</kbd>
                    </td>
                    <td className="qv-shortcuts__desc">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  );
}
