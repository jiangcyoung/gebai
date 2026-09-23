/**
 * 歌白 Web UI 独立配置文件（可选）——二次开发接入已有系统的扩展点。
 *
 * 本文件由页面自动引入（`index.html` / `files.html` 在模块脚本之前同步加载），放在构建产物根目录，
 * 与主程序源码解耦：升级歌白时整个文件原样保留即可，无需改动上游代码。缺省（或文件不存在）时
 * 歌白按内置默认行为运行。配置读取与应用的实现见 `packages/web/src/boot-config.ts`。
 *
 * 生效优先级（本文件不覆盖用户在设置里的选择）：
 *   URL 参数 > 用户本次手动选择 > 浏览器本地存储既有值 > 本文件 > 服务端全局配置 > 内置默认
 * 即：`storage` 里的规则只在歌白对应键**尚未设置**时写入；确需强制统一口径（如部署方锁定主题）
 * 时给该项加 `force: true`。
 *
 * 用法：取消注释并按需填写，然后在浏览器刷新页面即可生效（纯前端文件，不需要重启服务）。
 */
window.__GEBAI_WEB_CONFIG__ = {
  /**
   * ① 环境变量预置：随消息请求临时注入服务端（与「设置 → 环境变量」面板同一通道；
   *    仅存于本浏览器、不落盘到服务端）。服务端若配置了环境变量目录白名单，目录外的变量会被面板过滤。
   */
  env: {
    // GEBAI_LLM_MODEL: "local-qwen",
    // CODE_PROJECT: "my-project",
  },

  /**
   * ② 环境变量 ← 宿主系统 localStorage 键（运行时读取）：把已有系统的凭据/配置直接带进歌白环境变量。
   *    格式：{ 环境变量名: 宿主 localStorage 键 }。宿主键无值或读取失败时该项跳过。
   */
  envFromStorage: {
    // GEBAI_LLM_API_KEY: "myapp.llmKey",
  },

  /**
   * ③ 歌白设置 ← 宿主素材（沿用宿主系统的用户偏好，免二次配置）。
   *    值的写法：字符串 = 宿主 localStorage 键；或对象 { from } / { value } / { force }。
   *    可用键（歌白前端设置项）：
   *      gebai.ui.style         界面主题（acrylic/aether/cyberpunk/aurora/synthwave/matrix/tokyo-night/ink/cny/qinhan）
   *      gebai.ui.cnyScheme     人民币主题面额配色；值 "reset" 表示显式重置
   *      gebai.ui.acrylicLt     默认主题黑白（浅色/暗色）；值 "reset" 表示显式重置
   *      gebai.ui.lowPower      低性能模式（"on"/"off"）
   *      gebai.ui.fileDisplay   文件工具产物展示方式（"inline" 嵌入 / "popup" 弹窗）
   *      gebai.ui.approvalSkip  自动审批开关（"on"/"off"，仅对子Agent 只读工具生效）
   *      gebai.ui.env           浏览器本地环境变量（JSON 字符串，一般用上面的 env 更直观）
   */
  storage: {
    // "gebai.ui.style": "myapp.theme",
    // "gebai.ui.lowPower": { value: "on" },
    // "gebai.ui.approvalSkip": { from: "myapp.approvalSkip", force: true },
  },

  /**
   * ④ 外部链接携带提示词自动运行（URL 参数 `gb_prompt`，默认开启）：
   *    业务系统跳转链接可带任务进入歌白——自动新建会话并运行该提示词，随后地址栏重定向为会话地址
   *    （刷新只打开该会话，不会重复创建、重复执行）。置 false 关闭该入口。
   */
  // allowUrlPrompt: false,
}
