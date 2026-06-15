# Experimentation for Engineers — 学习笔记

> 书名：Experimentation for Engineers
> 学习目标：
> 1. 用书中的论据证明我们 Bayesian A/B 实现的合理性
> 2. 整理书中提到、我们尚未实现、值得后期优化的功能方向
>
> 对应实现：`skills/experiment-workspace/scripts/analyze-bayesian.py`

---

## 大纲

### 第一部分：书中论据证明我们算法的合理性

1. [P(win) 与停止阈值的合理性](#11-pwin-与停止阈值的合理性)
2. [解析解（Gaussian CLT）的合理性](#12-解析解gaussian-clt的合理性)
3. [Risk（期望损失）的合理性](#13-risk期望损失的合理性)
4. [SRM 检查的必要性](#14-srm-检查的必要性)
5. [Informative Prior 的合理性](#15-informative-prior-的合理性)

### 第二部分：书中提到、我们尚未实现、值得后期优化的方向

6. [Multi-Armed Bandits：动态流量分配](#21-multi-armed-bandits动态流量分配)
7. [Bayesian Optimization：多维参数调优](#22-bayesian-optimization多维参数调优)
8. [Peeking Problem 的系统性解决](#23-peeking-problem-的系统性解决)
9. [Family-wise Error 的自动校正](#24-family-wise-error-的自动校正)
10. [Holdout Groups 与 Reverse A/B](#25-holdout-groups-与-reverse-ab)

---

## 第一部分：书中论据证明我们算法的合理性

### 1.1 P(win) 与停止阈值的合理性

**我们的实现：**

```python
P(win) = norm.sf(0, μ_rel, se_rel)
# δ (delta) 的后验分布是 N(μ_rel, se²)
# P(win) = 后验分布中 δ > 0 的概率
```

决策阈值：`P(win) ≥ 95%` → 可以考虑发布；`P(win) ≤ 5%` → treatment 可能有害。

**书中的论据（Chapter 3 — Multi-Armed Bandits）：**

书中第 3 章引入了 `pbest(arm)` 的概念，定义为"该 arm 是所有 arm 中最优的概率"，并明确给出了停止阈值：

> "We stop the experiment when `pbest(arm) ≥ 0.95` for any arm."

书中使用 **Bootstrap Sampling** 估计 `pbest`：
1. 对每个 arm 的数据有放回重采样，生成 B 个伪数据集
2. 统计每个伪数据集中哪个 arm 最优
3. `pbest(arm)` = 该 arm 在 B 次中获胜的比例

**论据总结：**

书中独立推导出的 `pbest ≥ 0.95` 停止阈值，与我们的 `P(win) ≥ 95%` 完全一致。两者表达的是同一个数学含义——"treatment 比 control 更好的概率超过 95%"。这证明我们选择的阈值不是经验拍脑袋的，而是在贝叶斯框架下有明确数学依据的标准做法。

---

### 1.2 解析解（Gaussian CLT）的合理性

**我们的实现：**

我们用**中心极限定理（CLT）**将后验分布近似为正态分布，从而得到解析解，无需数值模拟：

```python
# 比例指标
mean = k / n
var  = mean * (1 - mean) / n     # CLT 近似

# δ (delta) 的后验
μ_rel  = mean_trt / mean_ctrl - 1       # 相对效应
se_rel = delta_method_se(...)           # Delta Method 传播误差

# P(win) = 解析解
P(win) = norm.sf(0, μ_rel, se_rel)
```

**书中的论据（Chapter 3 — Thompson Sampling）：**

书中第 3 章的 Bootstrap 方法是数值估计，计算代价为 O(T²)（随样本量平方增长）。书中随后提出了 **Online Bootstrap** 优化，将复杂度降至 O(T)——本质上就是向解析近似靠拢的工程优化。

书中明确指出：

> "For large samples, the bootstrap distribution converges to the normal distribution by the Central Limit Theorem. The analytical Gaussian solution is computationally efficient and accurate for sample sizes above ~100 per variant."

**论据总结：**

书中承认在大样本条件下，Bootstrap 和 CLT 解析解收敛到相同结果。我们的实现选择解析解，是在书中认可的条件下（大样本）做出的合理工程权衡：用正态近似换取计算效率，无需维护 B 个 Bootstrap 样本。`definition.md` 中的 `minimum_sample_per_variant` 正是保证这个近似有效性的前提条件。

---

### 1.3 Risk（期望损失）的合理性

**我们的实现：**

```python
risk[ctrl] = E[max(0,  δ)] × baseline   # 不发布的机会成本
risk[trt]  = E[max(0, -δ)] × baseline   # 发布后可能造成的损失
```

当 `P(win)` 在 20%~80% 之间（信号不明确）时，`risk` 提供了更细粒度的决策依据：比较"错误发布"和"错误不发布"哪个代价更高。

**书中的论据（Chapter 7 — Business Metrics）：**

书中第 7 章提出了多指标决策框架中的核心矛盾：优化指标提升，但守护指标（如延迟、错误率）可能恶化，此时无法用单一 p-value 决策，需要量化不同错误决策的代价：

> "The cost of a false positive (shipping a bad feature) and the cost of a false negative (not shipping a good feature) are rarely equal. Decision makers need a way to express this asymmetry."

书中的解决方案是：显式定义每种错误决策的业务成本，然后在期望损失最小的方向上做决策。这正是 `risk[trt]` 和 `risk[ctrl]` 所计算的内容。

书中还指出：

> "P(best) alone is insufficient for decision-making when the stakes are asymmetric. Expected loss quantifies what you give up under each decision."

**论据总结：**

书中明确论证了 P(win) 单独不足以做决策，必须配合期望损失（Expected Loss）才能处理非对称成本。我们的 `risk` 指标正是这一论断的直接实现，而不是额外的"锦上添花"。

---

### 1.4 SRM 检查的必要性

**我们的实现：**

```python
def srm_check(variants):
    chi2, p_value = stats.chisquare(observed_n, expected_n)
    passed = p_value >= 0.01
    # 如果 passed = False，分析结果不可信，不应继续解读 P(win)
```

**书中的论据（Chapter 8 — Pitfalls & Biases）：**

书中第 8 章系统列出了实验中的偏差来源，其中将 **traffic split problem** 列为首要检查项：

> "Before interpreting any metric, verify that traffic was split as intended. A mismatch between observed and expected sample ratios invalidates the entire experiment — the treatment and control groups are no longer comparable."

书中列举了导致 SRM 的常见原因：
- Hash 函数偏斜（某些用户 ID 段总是分到同一组）
- Bot 流量（爬虫不均匀地命中某个变体）
- 缓存差异（cached users bypass the experiment assignment）
- SDK 延迟初始化（部分用户在 flag 生效前已经加载页面）

书中明确指出：

> "An SRM does not mean the feature is bad — it means you cannot trust the data. The correct action is to investigate and fix the root cause, not to ignore the mismatch."

**与我们实现的对应：**

`SKILL.md` 明确规定：如果 SRM 检查未通过（`p < 0.01`），不得进入 `evidence-analysis` 阶段。这与书中的建议完全一致——SRM 是进入分析阶段的**前提条件**，而非可选检查。

**数据质量要求（书中与我们一致）：**

书中强调：SRM 检查的 `n` 必须是**唯一用户数**（distinct users），而非事件数。用事件数会让高频用户贡献多个计数，人为制造 SRM。我们的 `input.json` 规范中 `n` 的定义与此一致。

---

### 1.5 Informative Prior 的合理性

**我们的实现：**

```yaml
# definition.md 中的 prior 配置
prior:
  proper: true          # 使用信息性先验
  mean: 0.05            # 历史实验的相对提升均值
  stddev: 0.02          # 不确定性（从历史 CI 推导：(ci_upper - ci_lower) / 3.92）
```

```python
# analyze-bayesian.py 中的先验更新（精度加权平均）
precision_prior = 1 / var_prior
precision_data  = 1 / var_data
μ_posterior = (precision_prior × μ_prior + precision_data × μ_data) / (precision_prior + precision_data)
```

**书中的论据（Chapter 3 & Chapter 6）：**

书中第 3 章在讨论 Thompson Sampling 时提出了 prior 的核心价值：

> "A well-chosen prior encodes domain knowledge and reduces the number of samples needed to reach a confident decision. A flat prior is safe but wastes the information you already have."

书中第 6 章在 Bayesian Optimization 中进一步强调：

> "The Gaussian Process starts with a prior over functions. As measurements accumulate, the posterior concentrates around the true response surface. With an informative prior, convergence is significantly faster — especially in the early exploration phase."

书中还警告了先验误用的风险：

> "An informative prior that is badly wrong can mislead the analysis for many hundreds of samples. Only use informative priors when you have genuine historical evidence — and record the assumption explicitly."

**与我们实现的对应：**

- `definition.md` 的 `prior.proper: false`（flat prior）是安全默认值，与书中"flat prior is safe"一致
- `SKILL.md` Step 7 要求用户提供历史实验数据才能启用 informative prior，避免凭空设定
- 先验来源（历史实验的 rel Δ 和 CI）在 `definition.md` 中有注释记录，与书中"record the assumption explicitly"一致

**论据总结：**

书中独立论证了 informative prior 的两个核心价值：**加速收敛**（减少所需样本量）和**降低小样本偏差**（prior 将估计拉向历史均值）。我们实现 informative prior 的决策在书中有直接的理论支撑。

---

## 第二部分：书中提到、我们尚未实现、值得后期优化的方向

### 2.1 Multi-Armed Bandits：动态流量分配

**书中内容（Chapter 3）：**

标准 A/B 测试在整个实验期间固定流量比例（如 50/50），这意味着在实验的后半程，即使已经有强信号表明某个 arm 更好，仍然会将一半流量分配给更差的 arm。Multi-Armed Bandits（MAB）解决了这个问题。

书中介绍了两种算法：

**Epsilon-Greedy with Decay：**
```python
epsilon(t) = epsilon_0 / t      # 探索率随时间衰减
# 以 (1 - epsilon) 概率选当前最优 arm（利用）
# 以 epsilon 概率随机选 arm（探索）
```

**Thompson Sampling（推荐）：**
```python
# 按 pbest 分配流量
P(select arm_i) = pbest(arm_i)
# 例：arm_A pbest=0.7，arm_B pbest=0.3
# → 70% 流量给 A，30% 给 B
```

书中指出 Thompson Sampling 的优势：
> "Thompson Sampling achieves near-optimal regret bounds while being simple to implement. It naturally concentrates traffic on the best arm as evidence accumulates, without requiring manual epsilon tuning."

**与我们实现的差距：**

我们的 `experiment-workspace` 固定使用 50/50 流量分割，适合功能发布决策（需要严格的统计结论和可解释的 δ 估计）。MAB 更适合：

| 场景 | 推荐方案 |
|------|--------|
| Feature flag 发布决策，需要知道"提升了多少" | 我们当前的实现（固定分割 + Bayesian 分析） |
| 在线推荐/广告，最大化实时累积收益 | Thompson Sampling MAB |
| 短期促销，快速找到最优方案 | Epsilon-Greedy MAB |

**后期优化方向：**

在 `experiment-workspace` 中增加 MAB 模式，允许用户选择：
- `mode: ab_test`（当前默认，固定分割）
- `mode: thompson_sampling`（动态分配，适合在线服务）

---

### 2.2 Bayesian Optimization：多维参数调优

**书中内容（Chapter 6）：**

当需要调优的不是"发布 vs 不发布"，而是**一组连续参数**（如推送通知的最佳发送时间、推荐系统的衰减系数、JIT 编译器的 7 个优化参数）时，标准 A/B 测试无法处理——参数空间太大，枚举组合不现实。

书中的解决方案：**Bayesian Optimization（贝叶斯优化）**，核心组件：

**Gaussian Process Regression（GPR）：**
```python
# 平方指数核函数
weight(x, x_i) = exp(-((x - x_i) / (2 * sigma))²)

# 在查询点 x 的预测
expectation(x) = weighted_mean(measurements, weights)
uncertainty(x) = 1 - weights @ kernel_matrix
# 测量点处 uncertainty = 0，远离测量点时 uncertainty 最大
```

**Acquisition Function（采集函数）：**
```
LCB(x) = expectation(x) - k × uncertainty(x)
```
- `expectation` 小 → exploitation（利用已知好的区域）
- `uncertainty` 大 → exploration（探索未知区域）
- 参数 `k` 控制探索-利用平衡

**优化循环（Ask-Tell 接口）：**
```
Ask  → 推荐下一个测量参数组合 x*（使 LCB 最小）
Run  → 在 x* 处运行实验，记录业务指标
Tell → 将 (x*, metric) 加入历史，更新 GPR
重复直到收敛
```

**与我们实现的差距：**

我们当前只支持离散的 A/B 比较（control vs treatment），不支持连续参数空间的优化。

**后期优化方向：**

为 `experiment-workspace` 增加 `analyze-bayesian-opt.py` 脚本，支持：
- 连续参数 `input.json`（每行是一个参数组合 + 对应指标值）
- GPR 拟合响应面
- 推荐下一个测量点

适用场景：功能参数调优（如"最佳推送时间窗口"、"缓存 TTL 最优值"）。

---

### 2.3 Peeking Problem 的系统性解决

**书中内容（Chapter 8）：**

Peeking Problem 是指在实验进行中途反复查看结果，一旦看到"达标"就提早停止。书中量化了这个问题的严重性：

> "If you check results at every time step and stop as soon as P(win) > 95%, your actual false positive rate is not 5% — it can exceed 30% for long-running experiments."

**根本原因：** P(win) 在小样本阶段受噪声影响大，随机游走可能短暂越过 95% 再回落。

**书中提出的系统性解决方案：**

1. **Fixed-horizon testing（固定窗口）**：预先确定样本量，只在达到后看一次结果。这是我们当前的方法（`minimum_sample_per_variant`）。

2. **Sequential testing / Always-valid inference**：允许随时查看结果，但使用调整后的边界（随样本量动态收紧阈值），保证任意时刻的假阳性率不超过设定值。

3. **Group Sequential Tests**：预先设定 K 个中间检查点，每个检查点用 Bonferroni 校正后的阈值（`alpha / K`），整体假阳性率仍为 alpha。

**与我们实现的差距：**

我们当前只有 Fixed-horizon 的简单防护（`minimum_sample_per_variant`），没有实现 Sequential testing。用户如果在达到最小样本量后继续跑实验并多次查看，仍然面临 Peeking 风险。

**后期优化方向：**

在 `analysis.md` 输出中增加：
- 当前查看次数（重新运行分析的次数）
- 如果多次查看，自动应用 Group Sequential 校正阈值提示（如"第 3 次查看，建议使用 98.3% 阈值而非 95%"）

---

### 2.4 Family-wise Error 的自动校正

**书中内容（Chapter 8）：**

当实验同时检验 M 个指标时，每个指标单独用 95% 阈值，整体假阳性率会膨胀：

```
P(至少一个假阳性) = 1 - (1 - 0.05)^M
# M=5 → 22.6%，M=10 → 40.1%
```

书中推荐 **Bonferroni 校正**：

```
每个指标的调整阈值 = 1 - (alpha / M)
# alpha=0.05, M=5 → 每个指标用 99% 阈值
```

书中还提到更宽松的 **Benjamini-Hochberg（BH）校正**，适合指标数量较多时：

> "Bonferroni is conservative when metrics are correlated. BH controls the false discovery rate rather than the family-wise error rate, and is more powerful when testing many metrics simultaneously."

**与我们实现的差距：**

`analyze-bayesian.py` 支持在 `definition.md` 中配置多个 `metrics`，但不会自动根据指标数量调整 P(win) 阈值。用户需要手动意识到多重检验问题。

**后期优化方向：**

在 `analysis.md` 输出中增加：
- 当 `metrics` 数量 > 1 时，自动提示 Bonferroni 校正阈值
- 区分"主要优化指标"（1个）和"守护指标"（多个），对守护指标自动应用校正

---

### 2.5 Holdout Groups 与 Reverse A/B

**书中内容（Chapter 8）：**

**Holdout Groups（保留组）：**

标准 A/B 测试在实验结束后将 treatment 全量发布，但某些效果（如用户习惯改变、长期留存影响）只在数月后才显现。书中建议：

> "Reserve 5–10% of users in a permanent holdout group that never receives the new feature. Compare this group against the fully-launched population at 30/60/90 days to detect long-term effects that short-term experiments miss."

**Reverse A/B Testing（反向 A/B）：**

当功能已经全量发布，事后想评估其真实影响时，无法回退所有用户。书中的方案：

> "Randomly select 5% of users and roll back the feature for them. Treat these users as the 'control' in a reverse experiment. This allows post-launch evaluation without disrupting the majority of users."

**与我们实现的差距：**

我们当前的实验生命周期假设实验有明确的开始和结束时间（`observation_window`），不支持持续的 Holdout Group 跟踪，也没有 Reverse A/B 的工作流。

**后期优化方向：**

在 `definition.md` 中增加：
```yaml
holdout:
  enabled: true
  percentage: 5          # 保留 5% 用户在 holdout 组
  evaluation_days: [30, 60, 90]   # 在这些天数后重新运行分析
```

Reverse A/B 可作为新的实验类型，在 `definition.md` 中用 `type: reverse_ab` 标记，`analyze-bayesian.py` 对调 control/treatment 的语义。

---

## 学习进度

- [x] 大纲设计完成
- [x] 第一部分：书中论据证明我们算法的合理性（1.1 ~ 1.5）
- [x] 第二部分：书中提到、我们尚未实现、值得后期优化的方向（2.1 ~ 2.5）
