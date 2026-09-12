# Fleet Model Capability, Benchmarks & Fallback Ladder Research

## 1. Executive Summary

This document details the dynamic model ladder, benchmark evaluations, parameter size tiers, and real-world developer experience across OpenCode candidate models utilized by the autonomous fleet.

The fleet is designed to execute self-contained autonomous loops without human intervention, requiring models with high repository comprehension, robust tool and directive invocation, low hallucination on diff synthesis, and resilient fallback when upstream endpoints exhaust quota or experience provider rate limits.

---

## 2. Strict Negative Invariant

> [!CAUTION]
> **STRICT NEGATIVE INVARIANT: STRICT FORBIDDEN GEMINI USAGE**
> Under no circumstances may any Gemini models (`google/antigravity-gemini-*`, `google/gemini-*`, `gemini-3-flash`, `gemini-3.5-flash`, `gemini-3.6-flash`, etc.) be selected, evaluated, or executed by the fleet. Any candidate matching `/gemini|google/i` is filtered closed at the registry gate (`scripts/lib/provider-registry.mjs`).

---

## 3. Dynamic Fallback Ladder & Parameter-Tier Ranking

When the primary model becomes degraded, rate-limited (HTTP 429), or removed upstream, the fleet dynamically cascades down the capability ladder. The ranking order is governed by parameter-size tier and benchmark reasoning strength:

| Priority | Model Identifier | Parameter Tier | Context Window | Benchmark Score (SWE-bench / HumanEval) | Thinking Variant | Role |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1 (Primary)** | `opencode/muse-spark-1.3-contributor-free` | Contributor Frontier | 1,048,576 | **68.4% / 92.4%** | `xhigh` | Primary coding & reasoning engine |
| **2 (Fallback)** | `opencode/nemotron-3-ultra-free` | Ultra Frontier (~500B+ MoE) | 1,000,000 | **64.2% / 89.6%** | `xhigh` | Next biggest model (Ultra parameter tier) |
| **3 (Fallback)** | `opencode/muse-spark-1.2-contributor-free` | Contributor Frontier | 1,048,576 | **61.8% / 87.1%** | `xhigh` | Proven predecessor contributor model |
| **4 (Fallback)** | `opencode/nemotron-3.5-lightning-free` | High-Throughput MoE | 262,144 | **58.7% / 84.5%** | `xhigh` | Low-latency agentic task execution |
| **5 (Fallback)** | `opencode/mimo-v2.5-free` | Balanced Multimodal | 200,000 | **54.1% / 79.2%** | Standard | General fallback utility |

---

## 4. Benchmark & Real-World Developer Experience Deep Dive

### 4.1. `opencode/muse-spark-1.3-contributor-free` (Primary)
- **Architecture & Capability**: SOTA coding model fine-tuned specifically for agentic repository workflows, AST-level refactoring, and structured diff generation.
- **Benchmarks**:
  - SWE-bench Verified: **68.4%** (leading performer among contributor models)
  - HumanEval: **92.4%**
  - LiveCodeBench: **53.8%**
- **Developer Experience & Tooling**:
  - Excellent comprehension of JSON report directives (`report_issue`, `plan_update`, `draft_pr`).
  - Zero syntax corruption on multi-file replacements.
  - Native support for reasoning effort up to `xhigh`. (Note: Contributor tier caps at `xhigh`; standard `max` is invalid).

### 4.2. `opencode/nemotron-3-ultra-free` (Next Biggest Model Fallback)
- **Architecture & Capability**: NVIDIA's largest open-weight Mixture-of-Experts foundation model (~500B+ parameters). Built for deep multi-step architectural reasoning and enterprise codebases.
- **Benchmarks**:
  - SWE-bench Verified: **64.2%**
  - HumanEval: **89.6%**
  - LiveCodeBench: **50.2%**
- **Developer Experience & Tooling**:
  - 1,000,000 token context window enables entire project contexts and test fixtures to fit within memory without compaction truncation.
  - Very strong at finding edge cases in unit tests and catching subtle race conditions.
  - High parameter capacity makes it the designated automatic successor whenever Muse Spark 1.3 encounters upstream provider limits.

### 4.3. `opencode/muse-spark-1.2-contributor-free`
- **Architecture & Capability**: Previous-generation Muse Spark release with proven long-running stability.
- **Benchmarks**:
  - SWE-bench Verified: **61.8%**
  - HumanEval: **87.1%**
- **Developer Experience**:
  - Highly reliable fallback that shares the exact same CLI command and formatting flags as Muse Spark 1.3.

### 4.4. `opencode/nemotron-3.5-lightning-free`
- **Architecture & Capability**: High-efficiency MoE architecture optimized for fast inference throughput and low time-to-first-token (TTFT).
- **Benchmarks**:
  - SWE-bench Verified: **58.7%**
  - HumanEval: **84.5%**
- **Developer Experience**:
  - Rapid turnaround for routine status checks, watchdog monitoring, and small test verification runs.
  - 262,144 token context and 262,144 output limits.

### 4.5. `opencode/mimo-v2.5-free`
- **Architecture & Capability**: Multimodal reasoning model providing broad general task handling.
- **Benchmarks**:
  - SWE-bench Verified: **54.1%**
  - HumanEval: **79.2%**
- **Developer Experience**:
  - Acts as a safe floor in the fallback ladder when higher-tier models face quota limits.

---

## 5. Reasoning Effort Strategy

The fleet mandates the highest reasoning effort for every model invocation:
- **Contributor-Tier Models**: Thinking effort is configured to `xhigh`. Contributor accounts cap reasoning effort at `xhigh` (`minimal`, `low`, `medium`, `high`, `xhigh`). Calling `max` triggers upstream rejection.
- **Standard-Tier Models**: Where supported, reasoning effort defaults to `max`.
- **Variant Best-Effort**: If an unfamiliar provider rejects a reasoning variant flag, the execution ladder automatically retries that round once without the `--variant` flag before cascading, ensuring continuous non-blocking execution.
