# 测试

`_test_plan_anchor.mjs` —— **286 项断言**，覆盖 I1–I12 不变量、三类注入的触发时机与不重复性、
以及各类边界（中文信号词表的排除规则、证据对验收的匹配、熔断负向测试等）。
`_sim_plan_anchor_extreme.mjs` —— 5 个极端场景的确定性仿真。

## 怎么跑

```bash
# 1) 先装宿主依赖（它们是 peerDependencies，见 dsh/package.json）
cd dsh
pnpm add -D @deepseek-ai/cordis @deepseek-ai/dsh-tools @deepseek-ai/schemastery

# 2) 跑测试（从仓库根目录）
cd ..
node tests/_test_plan_anchor.mjs
node tests/_sim_plan_anchor_extreme.mjs
```

## 手记：为什么要先装依赖

这三个包是**宿主（DSH）在运行时提供的**，所以 `package.json` 里声明为 `peerDependencies` —— 这是正确的设计，
意味着插件不会把宿主的实现打包进来。

但**跑测试时会真的 import 它们**。所以刚 clone 下来直接跑测试会报
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'` ——
**这不是仓库坏了，是还没装依赖**。

好消息：这三个包都在**公开 npm registry** 上（实测 HTTP 200 可获取），所以外面的人装得到、跑得起来。
