// 构建生成物（`*.generated.json`）的类型声明：这些文件由 packages/server/scripts/build-*.ts 生成且多数已
// gitignore（桌面打包链才产出 core/cv.embedded.generated.json）。源码形态下缺失是设计内情形——运行时
// loadEmbeddedCvAssets 的 catch 回退到「未内嵌→给配置指引」，但 tsc 会报 TS2307。
// 通配声明让类型检查不依赖构建产物存在；运行时仍按各模块自己的 loadEmbedded* 走「缺失→回退/引导」。
declare module "*.generated.json" {
  const value: { version?: string; entry?: string; gzip?: boolean; driver?: string; files?: unknown }
  export default value
}
