# EgoLite 环境检查、安装与资料配置

## 1．检测本机是否已安装 EgoLite

- **Windows（PowerShell）**：
  ```powershell
  Get-Command ego-browser -ErrorAction SilentlyContinue
  # 不在 PATH 时检查默认安装路径：
  Test-Path "$env:USERPROFILE\.local\share\ego\active_version_dir\ego-browser.exe"
  ```
- **Windows（cmd）**：
  ```bat
  where ego-browser
  ```
- **macOS（zsh / bash）**：
  ```bash
  command -v ego-browser || ls "$HOME/.local/bin/ego-browser"
  ```
  存在但不在 PATH 时，临时加上 `export PATH="$HOME/.local/bin:$PATH"` 后重试。

### 验证运行时与版本

```bash
ego-browser nodejs -e "console.log('ego-browser ready')"
ego-browser skill
```

- 若提示 `skill` 为未知命令，说明版本偏旧，征得用户同意后执行 `ego-browser upgrade`（仍失败按下方重装）。

---

## 2．未安装时的安装步骤

安装包官网：`https://lite.ego.app/`

### Windows
1. 从 `https://lite.ego.app/` 下载 Windows 安装包并运行；
2. 若遇到 SmartScreen 提示，点击 **「更多信息」→「仍要运行」**；
3. 打开 EgoLite 完成首次 **Onboarding**（自动注册 `ego-browser` 到 `PATH`）；
4. **重开新的终端或 AI 会话**后，运行 `Get-Command ego-browser` 与 `ego-browser nodejs -e "console.log('ego-browser ready')"` 确认就绪。

### macOS
1. 从 `https://lite.ego.app/` 下载对应芯片（Apple Silicon `arm64` 或 Intel `x64`）的 `.dmg`；
2. 将 `ego lite.app` 拖入 `/Applications`（或 `~/Applications`）；
3. 若首次打开被系统拦截，清除隔离属性（或在「系统设置 → 隐私与安全性」放行）：
   ```bash
   xattr -dr com.apple.quarantine "/Applications/ego lite.app"
   ```
4. 打开 `ego lite.app` 完成首次 **Onboarding**（注册 `~/.local/bin/ego-browser`）；
5. 确认 `command -v ego-browser`（必要时在 `~/.zshrc` 添加 `export PATH="$HOME/.local/bin:$PATH"`）与 `ego-browser nodejs -e "console.log('ego-browser ready')"` 通过。

---

## 3．资料配置与首次登录

1. **海博中台资料（1 个）**：在 EgoLite 新建名为 **`采集`** 的资料（两个海博中台小仓、乐心宜在同一个登录态下切换，无需分资料），登录 `https://zt.hiboos.com/index.html`。
2. **美团商家后台资料（2 个独立账号）**：按中台分别新建两个资料，默认命名 **`小仓`** 与 **`乐心宜`**，分别登录 `https://shangoue.meituan.com/`（备用 `https://waimaie.meituan.com/`）。
3. **自定义资料名**：若本机已有其他命名资料，可在 `~/.xc-ego/preferences.json` 的 `profiles` 字段映射对应资料名。
4. 登录完成后回复「已就绪」，即可从原任务继续。

---

## 4．运行环境与启动防呆（防「发生个人资料错误」与服务挂起）

1. **宿主机非沙箱执行**：`ego-browser` 与 EgoLite 浏览器必须运行在具备用户资料目录读写权限的宿主机非沙箱环境中；Windows 下依赖 `%LOCALAPPDATA%\Citro Labs\ego lite\User Data`（含 `Local State`）的读写权限。
2. **先探活、严禁沙箱盲启**：执行前先运行 `ego-browser nodejs -e "await profiles()"` 探活；严禁在无 `User Data` 读写权限的沙箱或受限环境中直接冷启动 `ego.exe`，否则会弹出 Chromium「发生个人资料错误：系统无法读取您的偏好设置」阻塞弹窗。
3. **Windows 冷启动参数与权限前置校验**：若确需在宿主机由脚本冷启动 `ego.exe`，启动前须先校验 `User Data` 目录读写权限，并附带 `--disable-features=DestroyProfileOnBrowserClose`。
4. **服务挂起不并发重试**：若 `await profiles()` 长时间无响应，说明宿主 EgoLite 后台服务已挂起；严禁并发反复重试（避免多进程争抢锁或残留孤儿 `ego-browser` 进程），应提示用户检查或重启宿主 EgoLite 后再继续。
