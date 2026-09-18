# plan-anchor · 计划锚

> 仓库：<https://github.com/Paeonia-wh/paeonia-plan-anchor>

> 一个**防跑偏的护栏**：把多步计划从"上下文里的临时文字"变成"磁盘上的持久锚"。

**治的病**（用户原话，这是整个项目的起点）：

> "执行其中一规划的时候又发现了很多其他的问题，然后就**一路沿着其他的问题进行下去了**，
> 导致**其他的规划全忘记了，并且混乱了**"

---

## 它做什么

| 机制 | 说明 |
|---|---|
| **计划落盘成锚** | 计划与步骤写进本地 SQLite，跨会话、跨上下文压缩存活 |
| **回合重放锚** | 每一轮对话把锚顶回 AI 眼前——**这是它最承重的部分** |
| **新发现先入泊位** | 中途冒出的问题必须显式处置：`permit`（现在就做）/ `defer`（记下来 + 回程条件）/ `decline`（判定不做） |
| **回程票** | 被判"暂不做"的事到条件了会**主动提醒**，不靠 AI 记住 |
| **漂移预算** | 连续多轮没推进就提醒；AI 若确实在做当前步的长活，可用"在轨声明"把预算清零 |
| **完成闸门** | 最后一步做完**不许自称完成**——必须先问过用户 |

**它的立场一句话**：

> ### 偏离可以，沉默不行。

## 它不治什么（请先看这个）

1. **只在 AI 主动申报时有效** —— 它看不见"根本没申报的那件事"
2. **不能阻止跑偏**，只能让跑偏**不被忘记、不被隐藏**
3. **防不住改数据库** —— 能改你磁盘文件的程序，没法用同一磁盘上的东西约束它
4. **不判断"做得对不对"** —— 验收是语义判断，留给人

完整边界见 [`SPEC.md`](SPEC.md) 第 7 节。

## 装

**别自己照文档敲命令——把 [`AI-INSTALL.md`](AI-INSTALL.md) 交给你的 AI，让它先问你、再装。**
那份文件是**写给 AI 看的**，里面有一段可以直接照抄来问你的话，以及"装了会改动什么"的逐项清单。

## 验证装成功了

重启宿主后，在任意项目目录里让 AI 调一次 `plan_status`，应看到：

```
【计划锚】当前没有生效的计划。
（本项目作用域：<那个目录>）
```

**看到"作用域"那一行 = 它在工作，而且知道自己在哪个项目里。**

## 仓库里有什么

| 路径 | 是什么 |
|---|---|
| [`AI-INSTALL.md`](AI-INSTALL.md) | **给 AI 的安装说明**（先问用户 / 会改动什么 / 怎么卸载） |
| [`SPEC.md`](SPEC.md) | **规范**：不变量 I1–I12（每条注明强制层）、判据、信号词表 |
| [`DESIGN.md`](DESIGN.md) | 设计推演：为什么这么设计、证据、被否掉的替代方案 |
| [`dsh/`](dsh/) | **参考实现**（DSH 插件本体） |
| [`tests/`](tests/) | 286 项断言 + 极端场景仿真 |
| [`research/`](research/) | 调研与红队审计记录（**不含用户原话**） |

## English summary

**plan-anchor** is a drift guard for AI agents running multi-step plans. It persists the plan to
disk as a durable anchor, re-injects that anchor every turn, and forces every mid-task discovery to
be explicitly disposed of (`permit` / `defer` / `decline`) instead of silently chasing it. The
design position: **deviation is allowed, silence is not.** It ships as a DSH plugin reference
implementation plus a portable [spec](SPEC.md); the [install guide](AI-INSTALL.md) is written for an
AI agent, and requires it to ask the user before installing.

## License

MIT
