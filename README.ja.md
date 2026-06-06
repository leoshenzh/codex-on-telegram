<div align="center">

# Codex on Telegram

**ローカルの Claude Code / OpenAI Codex コーディングセッションを、Telegram からそのまま操作。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Runtime](https://img.shields.io/badge/runtime-Claude%20%7C%20Codex-blue.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

[English](./README.md) · [简体中文](./README.zh-CN.md) · **日本語**

</div>

---

Codex on Telegram は、**ローカルの AI コーディングセッション（Claude Code または OpenAI Codex）を Telegram のチャットから起動・バインド・再開できる**セルフホスト型のブリッジです。スマホから作業を始め、移動中に権限リクエストへ応答し、デーモンの再起動後もまったく同じセッションを再開できます。小さな macOS daemon として動作し、設計上 Telegram のみと通信します。

<p align="center">
  <img src="./docs/diagrams/architecture.png" alt="Codex on Telegram — architecture & message flow" width="900">
</p>

<p align="center"><sub>Telegram ⇄ bridge daemon (this repo) ⇄ Claude Code / OpenAI Codex ⇄ your local project · <a href="./docs/diagrams/architecture.html">interactive HTML</a></sub></p>

## ✨ 特長

- **2 つのランタイム、1 つのブリッジ。** 設定ひとつで Claude Code と OpenAI Codex を切り替えられます（`CTI_RUNTIME` = `claude` | `codex` | `auto`）。Codex SDK は*オプション*の依存関係なので、それがなくてもブリッジはインストールでき、動作します。
- **ウェッジ対策のストリーム監視。** 起動時・ストリーム途中・終端アイドルの各タイマーが、停止した Codex ストリームを検知して中断します —— 中途半端な回答を「完了」として黙って届けてしまうことはありません。
- **ツールを認識し、自己修復する。** 長時間かかるツール呼び出しが watchdog を誤作動させることはありません。ストリーム途中で一時的なタイムアウトが起きると、新しいスレッドで再試行します。ウェッジした処理を中断すると、リークさせるのではなく、実際に下位のサブプロセスを終了させます。
- **クラッシュに強い永続化。** 進行中のタスク状態と送信メッセージの参照はディスクに書き込まれるため、デーモンが再起動してもバインド済みの同じセッションを再開できます。
- **トピック単位のセッション。** プライベートチャット、グループ、そしてトピックを有効にしたグループは、それぞれ独自のバインド済みセッションを保持します。owner と allowlist のロックにより、Bot はあなた専用に保たれます。
- **運用機能を内蔵。** ワンコマンドでのデーモン制御（`start` / `stop` / `status` / `logs`）、`doctor` ヘルスチェック、そして macOS のスーパーバイザーを備えています。

## 仕組み

Codex on Telegram は、ベンダリングされた Telegram 専用ブリッジコアを包む薄いホストラッパーです。

- **ラッパー**（`src/`）は、Codex ランタイム、ディスク上の永続化、そして信頼性レイヤー（watchdog、再試行、中断処理）を追加します。
- **ブリッジコア**（`lib/`）—— Telegram アダプター、セッションルーティング、配信 / 再試行 / 重複排除、権限処理、入力検証、レート制限、そして Markdown→Telegram レンダリング —— は op7418 の [`claude-to-im`](#クレジット) で、変更を加えずそのままベンダリングしています。

## 動作要件

- **macOS**
- **Node.js ≥ 20**
- **Telegram bot token**（[@BotFather](https://t.me/BotFather) から取得）
- 少なくとも 1 つのランタイム：**Claude Code CLI**、および/または Codex 経路用の **`@openai/codex-sdk`**

## クイックスタート

```bash
git clone https://github.com/leoshenzh/codex-on-telegram.git
cd codex-on-telegram
npm install
npm run build
```

設定ファイルを作成します（データホームは `~/.claude-to-im/`）：

```bash
mkdir -p ~/.claude-to-im
cp config.env.example ~/.claude-to-im/config.env
```

`~/.claude-to-im/config.env` を編集し、少なくとも以下を設定します：

```bash
CTI_RUNTIME=codex                       # claude | codex | auto
CTI_TG_BOT_TOKEN=123456:your-bot-token  # from @BotFather
CTI_TG_OWNER_USER_ID=100000001          # your Telegram user ID (owner lock)
CTI_TG_ALLOWED_USERS=100000001          # comma-separated allowlist
CTI_DEFAULT_WORKDIR=/path/to/your/project
```

グループ / トピックで使う場合は、さらに `CTI_TG_REQUIRE_PRIVATE_CHAT=false` を設定し、@BotFather で Bot の**プライバシーモードを無効化**して、通常のグループメッセージがブリッジに届くようにしてください。

デーモンを起動します：

```bash
bash scripts/daemon.sh start
```

## デーモンコマンド

| コマンド | 機能 |
| --- | --- |
| `bash scripts/daemon.sh start` | ブリッジデーモンを起動 |
| `bash scripts/daemon.sh stop` | デーモンを停止 |
| `bash scripts/daemon.sh status` | 稼働状況を表示 |
| `bash scripts/daemon.sh logs [N]` | 直近 *N* 行のログを表示 |
| `bash scripts/doctor.sh` | ヘルス＆設定の診断を実行 |

## 設定

完全な一覧は [`config.env.example`](./config.env.example) にあります。よく使うフィールドは以下のとおりです：

| 変数 | 説明 |
| --- | --- |
| `CTI_RUNTIME` | バックエンドランタイム：`claude` / `codex` / `auto` |
| `CTI_DEFAULT_WORKDIR` | 新規セッションのデフォルト作業ディレクトリ |
| `CTI_DEFAULT_MODE` | デフォルトモード：`code` / `plan` / `ask` |
| `CTI_DEFAULT_MODEL` | 任意のモデル上書き（未設定の場合はランタイムのデフォルトを継承） |
| `CTI_TG_BOT_TOKEN` | Telegram bot token |
| `CTI_TG_OWNER_USER_ID` | owner 専用ロック（あなたの Telegram user ID） |
| `CTI_TG_ALLOWED_USERS` | カンマ区切りのユーザー / チャットの allowlist |
| `CTI_TG_REQUIRE_PRIVATE_CHAT` | `false` にするとグループ / トピックを許可 |
| `CTI_AUTO_APPROVE` | ツールの権限リクエストを自動承認 |
| `CTI_CODEX_*` | Codex ランタイムの上書き項目（承認ポリシー、サンドボックスモード、推論強度、ネットワークアクセスなど） |

## Telegram からの使い方

- **メッセージを送るだけ** —— プライベートチャット、グループ、トピックのいずれでも、まだ何もバインドされていなければセッションが自動的に作成されます。
- **`/sessions`** —— まず現在のセッションを、次に最近のブリッジセッションを、最後に検出可能なローカルの Codex セッションを一覧表示します。
- **`/bind <id|prefix>`** —— 完全な id または一意のプレフィックスで、Telegram のウィンドウやトピックを特定のセッションにバインドします（曖昧なプレフィックスは推測せず拒否されます）。
- トピックを有効にしたグループでは、各トピックが**独自の**セッションを保持します。通常のデーモン再起動では同じバインドが維持されるため、再バインドは不要です。

## プロジェクト構成

```
src/        Host wrapper: Codex provider, store, local-session discovery, daemon entry
lib/        Vendored bridge core (op7418's claude-to-im)
scripts/    Daemon control, doctor, macOS supervisor, build
docs/       Design notes & fix plans
```

## クレジット

Codex on Telegram は **op7418 の `claude-to-im`**（MIT）の二次的著作物です。[`lib/`](./lib) 配下の Telegram ブリッジコアは op7418 の成果であり、変更を加えずそのまま保持しています。Codex ランタイム、信頼性の強化、永続化の各レイヤーは本プロジェクトによる追加です。すべての元の著作権表示は保持されています —— [NOTICE](./NOTICE)、[LICENSE](./LICENSE)、[lib/LICENSE](./lib/LICENSE) を参照してください。

## ライセンス

[MIT](./LICENSE)。
