# Bayesian A/B 测试进阶教程（第二部分）

> 本教程基于以下资料：
> - 书籍：Experimentation for Engineers
> - 我们的实现：
>   - `skills/experiment-workspace/scripts/stats_utils.py` — 共享统计工具库
>   - `skills/experiment-workspace/scripts/analyze-bayesian.py` — Bayesian A/B 分析
>   - `skills/experiment-workspace/scripts/analyze-bandit.py` — Thompson Sampling 权重计算

---

## 目录

1. [Multi-Armed Bandits（多臂老虎机）](#第一章multi-armed-bandits多臂老虎机)
2. Sequential Testing 在贝叶斯框架下（待更新）
3. Family-wise Error 自动校正（待更新）
4. Holdout Groups（待更新）

---

## 第一章：Multi-Armed Bandits（多臂老虎机）

### 1.1 直觉：为什么需要 MAB？

我们当前的 A/B 测试流程是固定 50/50 流量，跑完整个实验周期再分析。但这有一个隐性代价：

> 实验跑了 5 天，P(win) 已经达到 88%，信号很强但还没到 95%。这时每一天你仍然在把 **50% 的流量分配给一个你已经认为更差的版本**。

这个被浪费的收益叫做 **Regret（遗憾值）**：把流量分配给次优 arm 所损失的业务收益。

MAB 的目标：**在实验过程中动态调整流量，让更好的 arm 越来越多地获得流量，同时保留探索能力防止误判。**

---

### 1.2 名字的来源：老虎机类比

想象你走进赌场，面前有 3 台老虎机（slot machine），每台中奖概率不同，但你不知道哪台更好：

```
老虎机 A：真实中奖率 30%（你不知道）
老虎机 B：真实中奖率 15%（你不知道）
老虎机 C：真实中奖率 45%（你不知道）
```

你有 1000 次机会，目标是赚到最多的钱。

- 只拉一台（纯利用）→ 可能一直拉最差的那台
- 均匀拉三台（纯探索）→ 浪费太多次在差的机器上
- **最优策略：边探索边把更多次数分给看起来更好的机器**

这就是 **Explore vs Exploit 的权衡**。名字来源：multi-armed = 多台机器，bandit = 老虎机（单臂强盗）。

**在 A/B 测试里：**

```
每个 arm = 一个 variant（变体），不是一个实验
同一个实验里可以有多个 arm：

arm_A = control（灰色按钮）
arm_B = treatment 1（蓝色按钮）
arm_C = treatment 2（红色按钮）
```

---

### 1.3 Thompson Sampling 核心机制

Thompson Sampling 的核心操作只有一步：

> **从每个 arm 的后验分布中各抽一个样本，谁抽到的值最大，就选谁。**

**具体步骤（以两个 arm 为例）：**

当前数据：
```
arm_A (control):   n=3000, k=63  → 转化率 2.1%
arm_B (treatment): n=3000, k=78  → 转化率 2.6%
```

**Step 1：为每个 arm 建立后验分布（CLT 近似）**
```
arm_A 后验：N(μ=0.021, se²=0.021×0.979/3000)
arm_B 后验：N(μ=0.026, se²=0.026×0.974/3000)
```

**Step 2：从每个后验各随机抽一个值**
```python
sample_A = np.random.normal(0.021, se_A)  # 比如抽到 0.023
sample_B = np.random.normal(0.026, se_B)  # 比如抽到 0.025
```

**Step 3：谁的 sample 更大，这一次选谁**
```
sample_A=0.023 < sample_B=0.025  → 这一次选 arm_B
```

**Step 4：重复 10000 次，统计每个 arm 被选中的比例**
```
arm_A 被选中：1800 次 → 18%
arm_B 被选中：8200 次 → 82%

→ 下一轮流量分配：arm_A 18%，arm_B 82%
```

---

### 1.4 为什么这个方法自动平衡探索与利用？

关键在于后验分布的**宽窄**随样本量变化：

```
样本少时：后验分布很宽（不确定性大）
          → 抽样结果随机性大
          → 各 arm 都有机会被选中
          → 自然保留探索能力

样本多时：后验分布很窄（越来越确定）
          → 更好的 arm 几乎每次抽到更大的值
          → 流量自动集中到最优 arm
          → 自然转向利用
```

**探索与利用的平衡是自动的，不需要手动调参。** 这是 Thompson Sampling 比 Epsilon-Greedy 更优雅的地方。

---

### 1.5 关于停止阈值：为什么是 95%？

95% 是**惯例，不是数学定律**。它来自频率学的 `alpha = 0.05`，整个行业用惯了。

在贝叶斯框架下，阈值是**业务决策**，取决于两种错误的代价：

| 错误类型 | 含义 | 代价 |
|---------|------|------|
| 错误发布（False Positive） | P(win) 高但 treatment 其实更差 | 用户体验受损 |
| 错误不发布（False Negative） | P(win) 低但 treatment 其实更好 | 失去潜在收益 |

**阈值选择原则：**
- 发布难以回滚 → 用更高阈值（99%）
- 有 feature flag 可以随时关掉 → 可以用更低阈值（90%）
- 守护指标（不能变坏）→ 反向检查 `P(harm) < 1%`

---

### 1.6 两个关键工程细节

Thompson Sampling 在实际工程中需要两个保护机制，都有书中的理论依据。

**细节一：Burn-in 期——每个 arm 至少 100 人才启动动态调权**

书中明确指出（Chapter 3）：

> "The bootstrap distribution converges to the normal distribution by the Central Limit Theorem for sample sizes above ~100 per variant."

样本量不足 100 时，后验分布极宽、噪声主导，此时算出的 P(best) 几乎是随机的。用噪声数据调整流量权重，反而会引入错误的早期偏斜，让一个"只是运气差"的 arm 过早失去流量。

**结论：Burn-in 阶段保持均等分配，每个 arm 都达到 100 人后再启动动态调权。**

**细节二：最低流量保底——每个 arm 保留至少 1%**

书中 Chapter 3（探索-利用权衡）明确说：

> "Never allocate zero traffic to any arm. Early data is noisy — an arm that looks bad after 50 samples may be the true winner. Keeping a minimum exploration floor ensures you can always recover from early misreadings."

书中 Chapter 8（Optimism Bias）也呼应：小样本下表现差的 arm，很可能只是运气不好。完全砍掉流量等于永久放弃修正机会。

**结论：无论 P(best) 多低，每个 arm 始终保留 ≥ 1% 的流量。**

**Top-Two 策略：减少"无效探索"**

在此基础上，可以进一步优化：只在 P(best) 最高的两个 arm 之间竞争主要流量，其余 arm 仅保持最低流量。

```
3 个 arm 的例子：
arm_A: P(best) = 70%
arm_B: P(best) = 25%
arm_C: P(best) = 5%

Top-Two 分配：
arm_A: 70/(70+25) = 73.7%
arm_B: 25/(70+25) = 26.3%
arm_C: 1%（最低保底，不完全放弃）
```

好处：把探索集中在"仍有机会的竞争者"之间，减少流量浪费在已经明显落后的 arm 上。

**与我们现有实现的关系：**

| | 我们的 A/B | Thompson Sampling MAB |
|--|-----------|----------------------|
| 流量分配 | 固定 50/50，全程不变 | 每轮按 P(win) 动态调整 |
| 实验期间 | 一直在"浪费"流量给次优 arm | 流量自动向更好的 arm 倾斜 |
| 最终结论 | δ (delta) 的估计更准确 | 积累的 Regret 更少 |
| 适合场景 | 需要知道"提升了多少" | 需要最大化实验期间的总收益 |

我们目前的 `P(win)` 计算（`norm.sf(0, μ_rel, se_rel)`）是 Thompson Sampling 抽样过程的**解析等价**——与其抽 10000 次再统计，不如直接算概率。两者在数学上等价。

MAB 需要的额外能力：把 P(win) **反馈给流量分配系统**，动态调整 variant 的权重。这需要和 FeatBit feature flag 的流量分配打通。

---

---

## 第二章：Sequential Testing 在贝叶斯框架下

### 2.1 Peeking Problem 是什么？

Peeking（提早看结果）是指在实验进行过程中反复查看统计结论，一旦"达标"就提前停止。

**为什么在频率学里是严重问题？**

频率学的 p-value 有一个隐含前提：你只在实验结束时看一次。如果你每天查看，一旦 `p < 0.05` 就停止，实际的假阳性率可能高达 30%。

书中明确量化了这个风险（Chapter 8）：

> "If you check results at every time step and stop as soon as P(win) > 95%, your actual false positive rate is not 5% — it can exceed 30% for long-running experiments."

原因：p-value 在实验过程中随机游走，会在某个时刻碰巧低于 0.05 然后反弹。你恰好在峰值停止，就锁住了一个噪声信号。

**贝叶斯框架是否有同样的问题？**

理论上更宽松，但实践上仍需注意：

- 贝叶斯后验概率在任何时间点都是对当前数据的**合法、完整描述**——这是贝叶斯的核心性质，叫做 **"posterior coherence"**（后验一致性）
- 理论上，你随时看 P(win) 都不需要校正
- 但如果你**因为 P(win) 短暂超过 95% 就停止**，你仍在做隐式选择：挑了一个 P(win) 偶然飙高的时刻，导致 δ (delta) 的估计偏高

这个问题叫做 **Optional Stopping Problem**。贝叶斯学界对此有争议，但实践中需要保护机制。

---

### 2.2 为什么我们不实现 Sequential Testing？

这是一个有理有据的设计决策，不是忽略。

**原因一：贝叶斯框架理论上不需要**

贝叶斯后验不依赖"只看一次"的前提，随时查看 P(win) 在理论上都是合法的。Sequential Testing 解决的是另一套统计方法的问题，不适用于我们的框架。

**原因二：我们已有足够的实践保护**

| 保护机制 | 作用 |
|---------|------|
| `minimum_sample_per_variant` | Burn-in：防止噪声后验，在样本不足时不运行分析 |
| `risk[trt]` | 比 P(win) 更稳健的停止信号——考虑了"如果错了，损失多少" |

`risk[trt]` 的优势：P(win) 在小样本时波动大，容易因噪声短暂超过阈值；risk 需要同时满足"方向正确"且"损失可接受"，更难被噪声触发。

**原因三：严格的贝叶斯序贯方法存在，但复杂度超过实际需要**

数学上确实存在贝叶斯序贯分析方法（Bayes Factor、ROPE+HDI、Expected Loss Threshold），但对产品实验团队理解和解释成本过高，收益有限。我们用 `risk[trt] < ε` 作为更自然的替代。

---

### 2.3 我们实际怎么做？

**当前实现的保护（已有）：**

**1. Burn-in 保护** — `definition.md` 中配置：
```yaml
minimum_sample_per_variant: 1000   # 根据基线转化率计算，不是固定值
```
`analyze-bayesian.py` 在输出中会显示当前样本量是否达到这个门槛。未达到时，P(win) 和 risk 仍会计算，但应视为参考而非决策依据。

**2. 更稳健的停止判断** — 不只看 P(win)，同时看 `risk[trt]`：

```
P(win) ≥ 95%  且  risk[trt] 足够小  →  才考虑停止
```

**建议的操作规范（文档说明，不需要代码实现）：**

1. **预先确定实验周期**，不要因为"看起来有信号了"就提前停止
2. **P(win) ≥ 95% + risk[trt] 足够小**，两个条件都满足再考虑停止
3. **如果必须中途查看**，提高阈值（如 P(win) ≥ 98%），用更严格的标准补偿多次查看的代价

> **书中的务实建议（Chapter 8）**：预先固定实验周期（Fixed-horizon testing）是最简单有效的方案。在没有序贯检验框架的情况下，"不提前看、不提前停"比任何统计校正都更容易执行。我们的 `minimum_sample_per_variant` 正是这个思路的工程实现。

---

---

## 第三章：Family-wise Error（多重检验问题）

### 3.1 问题的来源

假设你的实验配置了 5 个指标，每个都用 P(win) ≥ 95% 判断。直觉上每个指标都有 95% 的把握——但整体上真的是这样吗？

```
P(至少一个误判) = 1 - (1 - 0.05)^M

M=1  →  5%
M=5  →  22.6%
M=10 →  40.1%
M=20 →  64.2%
```

**你以为每个指标都有 95% 把握，但同时看 5 个指标，整体有 22.6% 的概率在至少一个指标上做出错误结论。** 这就是 **Family-wise Error**——一族检验整体的错误率远高于单个检验。

> **书中论据（Chapter 8）**：书中明确指出这个问题，并给出了 Bonferroni 校正公式：`每个指标的调整阈值 = 1 - (alpha / M)`。例如 5 个指标、alpha=0.05，每个指标应用 99% 阈值而非 95%。

---

### 3.2 主要指标 vs 守护指标：不对称的逻辑

这个问题对主要优化指标和守护指标的影响**完全不同**：

**主要优化指标：**
- 问题是"treatment 是否更好？"
- False positive（误判为有效）代价高：发布了没用甚至有害的功能
- 应该保持高阈值（95%），多个主要指标才需要校正

**守护指标：**
- 问题是"有没有变坏？"
- False negative（漏掉真正的伤害）代价高：发布了实际有害的功能
- 对守护指标做 Bonferroni 校正是**反向操作**——提高阈值让你更难发现真正的问题

**结论：守护指标不适合做 Family-wise Error 校正，应保持甚至降低阈值。**

---

### 3.3 什么时候真正需要注意？

**场景一：标准配置（1 主要指标 + N 守护指标）**
不需要校正。主要指标只有 1 个，不存在多重比较问题；守护指标应保持敏感。

**场景二：多 arm 实验（A/B/C/n）**

同时比较 3 个 arm，每个 arm vs control 都是一次独立检验：

```
arm_B vs control: P(win) ≥ 95%?
arm_C vs control: P(win) ≥ 95%?
arm_D vs control: P(win) ≥ 95%?
```

这 3 次检验同时进行，整体假阳性率膨胀。建议手动提高阈值：

```
M 个 arm 对比 → 建议阈值 = 1 - (0.05 / M)

M=2  →  97.5%
M=3  →  98.3%
M=5  →  99%
```

**场景三：用户配置了多个主要优化指标（少见）**
需要用户自行意识到并提高阈值，同上公式。

---

### 3.4 我们为什么不实现自动校正？

**原因一：贝叶斯框架与频率学不同**

Family-wise Error 校正（Bonferroni、BH 等）在数学上是针对 p-value 的校正方法。书中的推导和建议也是在频率学语境下。P(win) 是后验概率，不是 p-value，两者的统计性质不同。

**原因二：我们的典型配置不受影响**

标准的"1 主要指标 + N 守护指标"结构——这是我们推荐的实验设计——不需要多重比较校正。

**原因三：校正阈值应由用户决定**

多 arm 实验时，用户需要根据自己的业务风险容忍度决定阈值。自动校正可能过于保守（Bonferroni 在指标相关时过严），或不够（BH 控制的是 FDR 而非 FWER）。给出建议公式比自动校正更透明。

---

### 3.5 操作建议

| 实验配置 | 建议 |
|---------|------|
| 1 主要指标 + N 守护指标 | 主要指标用 95%；守护指标用 P(harm) < 5% 反向检查 |
| 2 个 arm 对比（标准 A/B） | 95% |
| 3 个 arm 对比 | 提高到 98.3% |
| 5 个 arm 对比 | 提高到 99% |
| 多个主要优化指标 | 重新考虑实验设计——通常应拆分为独立实验 |

> **书中的务实建议（Chapter 8）**：尽量只设定一个主要优化指标，其余作为守护指标。这不只是统计上的建议，也是业务上的好习惯——一个实验回答一个问题。

---

---

## 第四章：Holdout Groups（保留组）

### 4.1 为什么需要 Holdout Group？

A/B 实验通常只持续几天到几周。这个时间窗口内，很多**短暂因素**会污染实验结论：

| 效应 | 描述 |
|------|------|
| **Novelty Effect（新奇效应）** | 用户因新鲜感短暂改变行为，效果随时间衰减 |
| **热点/事件效应** | 发布期间恰逢营销活动或病毒传播，流量质量异常 |
| **季节性效应** | 节假日、大促等特殊时段的用户行为与日常不同 |
| **Primacy Effect（首因效应）** | 老用户短期抵触变化，功能其实更好但实验期间看起来更差 |
| **Hawthorne Effect** | 用户意识到自己在被测试时行为发生改变 |

这些因素有一个共同特点：**它们是短暂的**。14 天的实验恰好捕捉到了异常期，错把短期行为当成长期效果。

> **书中论据（Chapter 8）**：书中明确指出短期实验无法捕捉长期行为变化，建议在全量发布后保留一个永久对照组来跟踪长期效果。

---

### 4.2 Holdout Group 是什么？

**在全量发布新功能时，保留一小部分用户（通常 5%）始终使用旧版本**，即使功能已经对其他所有用户开放。

```
全量发布后的流量分配：

95% 用户  →  新功能（全量）
5% 用户   →  旧版本（holdout 组，长期保留）
```

然后在 30 天、60 天、90 天后，将 holdout 组和全量组对比分析。

**为什么这样能抵消外部因素？**

holdout 组和全量组的用户经历的是**完全相同的外部环境**（同样的季节、同样的热点、同样的市场），唯一的区别是功能版本。因此外部因素自然被抵消，剩下的差异就是功能本身的长期效果。

---

### 4.3 和 A/B 测试的根本区别

| | A/B 测试 | Holdout Group |
|--|---------|--------------|
| **目的** | 发布决策（ship or not） | 长期效果验证（was the decision right?） |
| **时机** | 发布前 | 发布后 |
| **持续时间** | 几天到几周 | 几个月 |
| **流量比例** | 50/50 | 95/5（小保留组） |
| **分析方法** | 同 `analyze-bayesian.py` | 同 `analyze-bayesian.py`，但观察窗口更长 |

---

### 4.4 用 FeatBit Feature Flag 实现 Holdout Group

Feature flag 天然支持 holdout 的实现方式：

**步骤一：全量发布时保留 5% 用户在旧 variant**

```
feature flag: new-onboarding-flow
  control (旧版本):   5%   ← holdout 组
  treatment (新功能): 95%
```

不关闭实验，只是调整流量比例。

**步骤二：定期收集两组数据**

和 A/B 实验一样，定期拉取 holdout 组和全量组的指标数据，写入 `input.json`。

**步骤三：运行分析**

```bash
python .featbit-release-decision/scripts/analyze-bayesian.py <slug>-holdout-30d
python .featbit-release-decision/scripts/analyze-bayesian.py <slug>-holdout-60d
python .featbit-release-decision/scripts/analyze-bayesian.py <slug>-holdout-90d
```

每个时间点单独建一个实验 slug，对比长期趋势。

**步骤四：观察效果是否持续**

```
发布后 14 天（原始实验）：P(win) = 97%，rel Δ = +8%
发布后 30 天（holdout）：  P(win) = 85%，rel Δ = +4%   ← 效果衰减
发布后 60 天（holdout）：  P(win) = 62%，rel Δ = +2%   ← 继续衰减
发布后 90 天（holdout）：  P(win) = 51%，rel Δ = +0.5% ← 基本消失
```

这个模式说明当初的 +8% 主要是新奇效应，功能的真实长期价值很小。

---

### 4.5 我们目前的实现差距

`experiment-workspace` 当前没有内置的 holdout 工作流，但可以用现有工具手动实现：

**已有的能力（可以复用）：**
- `analyze-bayesian.py` 完全适用于 holdout 分析，输入格式相同
- Feature flag 的流量分配可以手动设置 95/5

**缺失的能力（需要手动处理）：**
- 没有自动提醒"30/60/90 天后重新分析"的机制
- 没有将多个时间点的结果汇总对比的报告

**实践建议：**

在 `definition.md` 中记录 holdout 计划：

```yaml
holdout:
  enabled: true
  percentage: 5
  check_at_days: [30, 60, 90]
  # 提醒自己在这些日期重新收集数据并运行分析
```

这是文档注释，不影响脚本运行，但在 `evidence-analysis` 阶段可以提醒决策者关注长期跟踪。

---

## 学习进度

- [x] 第一章：Multi-Armed Bandits（1.1 ~ 1.6）
- [x] 第二章：Sequential Testing 在贝叶斯框架下
- [x] 第三章：Family-wise Error 自动校正
- [x] 第四章：Holdout Groups
