# makora changelog

Generated from conventional commits by `scripts/release-plan.mjs` in the release PR; do not edit by hand.

## [0.5.0](https://github.com/mr-jones123/makora/releases/tag/makora-v0.5.0) - 2026-11-26

### Features

- **makora:** pstack roles and panel seats can run on any model ([0e1cf42](https://github.com/mr-jones123/makora/commit/0e1cf422d4ae1be99fb1e4bad7c21d406835a389))
- **makora:** /review, a code review the main model fans out to review subagents ([a1bf210](https://github.com/mr-jones123/makora/commit/a1bf210d09754aa228fbcc416805283d5fc433fa))

### Fixes

- **coding-agent:** move tests and defaults off models the upstream catalog dropped ([cdcd44a](https://github.com/mr-jones123/makora/commit/cdcd44a1c1eb4d7a07e6fbaa3a3f546bee9ad92d))

## [0.4.0](https://github.com/mr-jones123/makora/releases/tag/makora-v0.4.0) - 2026-11-21

### Features

- **makora:** show queued prompts and steer the running turn with Alt+Enter ([36d0e7d](https://github.com/mr-jones123/makora/commit/36d0e7dabdb95e1e99a2d5b7f4284110b3cc5fdf))

## [0.3.0](https://github.com/mr-jones123/makora/releases/tag/makora-v0.3.0) - 2026-11-18

### Features

- makora memory: /dream, memory.search, and the Obsidian wiki ([b0cb6f9](https://github.com/mr-jones123/makora/commit/b0cb6f96c7d7864a03a0adbc6088f23327863caa))

### Fixes

- makora status row keeps the context gauge, and Ctrl+O toggles once ([6ee301a](https://github.com/mr-jones123/makora/commit/6ee301a5d8bb90b23d0698f3d3a8cc684cedb7aa))

## [0.2.0](https://github.com/mr-jones123/makora/releases/tag/makora-v0.2.0) - 2026-11-17

### Features

- makora /diff full screen with f ([2553349](https://github.com/mr-jones123/makora/commit/2553349eabf4865921af57320f03b4e0510c2352))
- makora names a session with the model, not just its first line ([930732a](https://github.com/mr-jones123/makora/commit/930732acbd9a5c4cf71653d698b48a1d87038df5))
- makora /verify-rules, TLA+ rules checked across input values on one page ([c7e834f](https://github.com/mr-jones123/makora/commit/c7e834f1ed27b0f05dffe9e4682744b5b963bf14))

## [0.1.1](https://github.com/mr-jones123/makora/releases/tag/makora-v0.1.1) - 2026-11-17

### Fixes

- makora images: Ctrl+V paste, images sent with messages, and show() from cells ([fec0141](https://github.com/mr-jones123/makora/commit/fec014195d9538ae3f9929794fdd33f72fb22150))

## [0.1.0](https://github.com/mr-jones123/makora/releases/tag/makora-v0.1.0) - 2026-11-17

### Features

- makora releases with install.sh, makora update, and versioning from conventional commits ([46f9f64](https://github.com/mr-jones123/makora/commit/46f9f64f5d7b420678273c498e3bb46e0fb34996))
- makora /quiz lists commits newest first ([f7eec26](https://github.com/mr-jones123/makora/commit/f7eec2668eb562a44a77dc9ded4de6da94a52f68))
- makora /quiz jumps straight to notes ([7635858](https://github.com/mr-jones123/makora/commit/76358583ef69165589a8958ed9146dc484cfccba))
- makora /quiz inline notes on the diffs ([e4f814e](https://github.com/mr-jones123/makora/commit/e4f814e7f68374715ea519dd19aa1243ca171332))
- makora /quiz, a standalone HTML quiz on what a session built and decided ([76a24e6](https://github.com/mr-jones123/makora/commit/76a24e63ace1ffc767b3a5f5346499a367b17ac8))
- makora pstack model roles and the /pstack picker ([200eb9b](https://github.com/mr-jones123/makora/commit/200eb9be67751afb1280672660ac5c58f3195457))
- makora rm, worktree cleanup, per-repo git write queue, slots for woken subagents, dashboard scrolling ([21b1f80](https://github.com/mr-jones123/makora/commit/21b1f806d793f0903b6882e5ddea4f9dae9db097))
- makora subagents with worktrees, and the agents dashboard ([4eb09a1](https://github.com/mr-jones123/makora/commit/4eb09a12fb66d534cbc5839f1c69afe0290654fd))
- makora /fork with the fork point's variables and files ([f3901f3](https://github.com/mr-jones123/makora/commit/f3901f3b5c816593b5bb37d25586dc14d20e605e))
- makora Python REPL with per-cell snapshots, and a /diff view ([c8e8e7a](https://github.com/mr-jones123/makora/commit/c8e8e7a1bde849604baeaf2e7eb08fb3413c4d6e))
- add makora, a Durable-based harness app (phase 1) ([7ab3e56](https://github.com/mr-jones123/makora/commit/7ab3e56b37a5ae1a8cd8a5327a276de76ac2eec8))
- **ai:** keep Anthropic OAuth account and organization, PI_AI_CLAUDE_CODE_VERSION override ([5f5cc04](https://github.com/mr-jones123/makora/commit/5f5cc04289119297775e5447c8cc1f8be672a498))

### Fixes

- **ai:** Together Kimi K3 test expects the upstream 1M output limit ([60b7b61](https://github.com/mr-jones123/makora/commit/60b7b6152dd3e5c6bb474e2259649a3ba58186ac))
- makora subagents waiting on their own children give back their running slot ([4781d24](https://github.com/mr-jones123/makora/commit/4781d24260017669ac3ddb88cc8005c6f0f94bc3))
