/**
 * 屏蔽浏览器原生右键菜单（两个页面入口各调用一次：聊天页 `main.ts` / 工作台 `files/main.ts`）。
 *
 * 为何全局禁：这是自绘界面的应用，原生菜单里能用的（返回 / 重新加载 / 另存为 / 打印 / 检查…）
 * 全是浏览器壳的东西——它弹出的那一刻，界面就从「应用」被打回「网页」。而真正需要右键的地方
 * 都有自绘菜单（会话列表 / 资源管理器 / 变更 / 日志 / 比较 / 终端 / 待办），全局禁掉不损任何功能。
 *
 * **只 preventDefault，不 stopPropagation**：Monaco 编辑器与上述各面板的自绘菜单都挂在同一个
 * `contextmenu` 事件上（各自 preventDefault 后弹自己的浮层）。一旦在这里阻断传播，它们会一起失效。
 * 监听挂在 document 的冒泡阶段即可——元素自己的处理器先跑，浏览器默认菜单最后才判。
 *
 * 代价：输入框原生的「剪切 / 复制 / 粘贴」菜单也没了，键盘 Ctrl+X/C/V 照常可用。
 */

export function blockNativeContextMenu(target: EventTarget = document): void {
  target.addEventListener("contextmenu", (e) => e.preventDefault())
}
