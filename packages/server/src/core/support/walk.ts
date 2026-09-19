/**
 * 目录递归遍历（重导出 SDK 实现，**单一来源**）：grep 范围外路径与 code/explore 项目根遍历共用。
 *
 * 实现位于 `@gebai/sdk/node` 的 `walk.ts`——server 侧不再保留副本。两份实现并存时，任一侧的修改
 * 都会让另一侧静默漂移（曾发生：两版都把 `modifiedAt` 恒置为 0，而各自注释都写着「并发 stat」），
 * 这类漂移不会出现在任何测试里，直到下游工具拿着 1970 年的时间做排序才发现。
 */
export { WALK_MAX_DEPTH, WALK_SKIP_DIRS, walkDirFiles } from "@gebai/sdk/node"
