# Mac 版打包说明

## 一句话

**mac 的安装包必须在 Mac 上打**（`.dmg` 依赖苹果的 `hdiutil`/`codesign`，Windows 上做不出来；
硬拼出来的 zip 里 `.app` 的可执行权限是坏的，拿到 Mac 上双击打不开）。
Windows 上的 `Nova-Studio-HK/L-*.exe` 照旧，mac 版另出一套文件，两套并存不冲突。

**手上没有 Mac？** 用第二方案：推到私有仓库 → GitHub 云端 macOS 打包（见文末「三、没有 Mac 怎么办」）。

**只想赶紧用上？** 不需要打包：项目里已备好「端口运行版」（`Nova-Studio-L-Mac.tar.gz`），
Mac 上装个 Node 就能双击启动，界面在浏览器里。

---

## 一、在 Mac 上怎么打（3 步）

### 1. 装 Node.js

去 https://nodejs.org 下 **LTS 版（20 以上）**，一路下一步装完。
验证：打开「终端」输入 `node -v`，能打印版本号就行。

### 2. 把项目拷到 Mac

拷**整个 `nova-image-studio` 文件夹**（U 盘 / 网盘 / git 都行）。

- **不用拷 `node_modules`**（几百 MB，而且里面是 Windows 版的 Electron，拷过去反而会打不出包；脚本会在 Mac 上重装）
- 不用拷 `release/`（那是 Windows 打出来的包）

### 3. 双击打包

| 想打的版本 | 双击这个文件 |
|---|---|
| **L 版**（只带通用记忆种子） | `打包Mac版-L.command` |
| HK 版（带全部记忆种子） | `打包Mac版-HK.command` |

> 第一次双击如果提示「无法执行」/「没有权限」，在「终端」里先跑一次：
> ```bash
> cd 项目目录 && chmod +x "打包Mac版-L.command"
> ```
> 或者不用双击，直接命令行跑（不需要权限位）：
> ```bash
> bash build-mac.sh l     # L 版；打 HK 版换成 hk
> ```

第一次跑要下载 Electron（约 100 MB）+ 装依赖，几分钟；之后就快了。

---

## 二、产物长什么样

在 `release/` 目录下：

| 文件 | 给谁用 |
|---|---|
| `Nova-Studio-L-<版本>-mac-arm64.dmg` | **苹果芯片 Mac（M1/M2/M3/M4）** 手动安装 |
| `Nova-Studio-L-<版本>-mac-x64.dmg` | **Intel 芯片 Mac** 手动安装 |
| `Nova-Studio-L-<版本>-mac-arm64.zip` | 给自动更新用（macOS 上 electron-updater 只认 zip） |
| `Nova-Studio-L-<版本>-mac-x64.zip` | 同上 |
| `l-mac.yml` | 更新清单（mac 端叫「通道名-mac.yml」） |

发给队友时：**先问一句是苹果芯片还是 Intel**，给对应的 `.dmg`，拖进「应用程序」即可。
不确定芯片的：Mac 左上角  → 「关于本机」→ 看「芯片」那行（Apple M 系列 = arm64，Intel = x64）。

---

## 三、上传到 GitHub Release（可选，为的是自动更新）

跟 Windows 版传到**同一个 release**（同一个版本号下）：

**路线 A：网页拖**（零配置）
打开 `https://github.com/l1307047595/nova-studio-release/releases` → 找到对应版本 → Edit → 把上面 5 个文件拖进去。

**路线 B：脚本**（Mac 上也能跑，已改成跨平台）
```bash
NOVA_RELEASE_APPROVED=1 bash publish-release.sh 3.4.1 l      # 只发 l 通道（批准标记必须带）
```
它会自动跳过不存在的文件，传完还会回读核对资产清单。

---

## 四、两个必须知道的限制（未签名）

我们**没有买 Apple 开发者证书（$99/年）**，所以 mac 包是未签名的，后果两条：

1. **队友第一次打开会被拦**
   - 正常做法：右键（或 Control+点）点图标 → 「打开」→ 再点一次「打开」，之后就不再拦了
   - 或者终端里跑一次：`xattr -cr "/Applications/Nova Studio L.app"`

2. **⚠️ Mac 版收不到自动更新**
   Squirrel.Mac 会校验代码签名，未签名的包更新时会失败（日志里能看到签名校验报错）。
   也就是说：**mac 版目前只能手动下新 dmg 覆盖安装**。
   要 mac 也能自动更新，只有两条路：
   - 买 Apple 开发者账号 → 签名 + 公证（notarize），然后把证书配进打包流程；
   - 或者保持手动更新（对内部工具通常够用）。

   程序不会因此崩：更新检查失败只在日志里记一行，应用照常用。

---

## 五、记忆种子行为（跟 Windows 版完全一致）

- 打包时把种子放进 `backend/memory-seed`
- **首次运行、且本地还没有记忆时**才导入
- **已有记忆绝不覆盖**（升级安装不会把你的记忆冲掉）

所以 L 版 = 只带「通用」类目种子，HK 版 = 带「捏捏乐 / 通用 / 美妆」三个类目种子。

---

## 六、常见报错

| 现象 | 原因 / 解决 |
|---|---|
| `❌ 没装 Node.js` | 装 Node LTS：https://nodejs.org |
| 双击 .command 没反应 / 提示无法执行 | 没执行权限 → `chmod +x "打包Mac版-L.command"`，或用 `bash build-mac.sh l` |
| `npm install` 卡住/报网络错 | 换国内镜像：`npm config set registry https://registry.npmmirror.com` 后重试 |
| `better-sqlite3` 报 `node-gyp` / 找不到编译器 | 它在退回本地编译（国内拉不到预编译包）→ 换网络或走代理重跑；正常情况下它自带 darwin 预编译，不需要 Xcode |
| 卡在下载 Electron | 加镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再跑 |
| 打包报签名相关错误 | 确认命令里带了 `CSC_IDENTITY_AUTO_DISCOVERY=false`（脚本已带） |
| 打开 dmg 里的 app 提示「已损坏」 | 未签名 + 下载来源标记 → `xattr -cr "/Applications/Nova Studio L.app"` |
| **云端构建 30 秒就失败，日志写 `unbound variable`** | 脚本里 `$变量` 后面紧跟了全角字符（如 `$PRODUCT（`），macOS 的 bash 会把全角字节并入变量名 → 改成 `${PRODUCT}` 花括号写法（`bash -n` 查不出来，本地 Windows 也不复现，必须改完重跑云端才算验过） |

---

## 七、没有 Mac 怎么办：GitHub 云端打包

GitHub 免费提供 **macOS 运行器**，可以在云端把 mac 包打出来，你手上一台 Mac 都不需要。
项目里已备好工作流：`.github/workflows/build-mac.yml`。

**一次性准备**

1. 把项目推到一个**你自己的私有仓库**（Private）。
   私有 = 源码不公开，同时满足「不暴露源码」和「能跑 Actions」两个条件。
   ```bash
   git remote add origin git@github.com:<你的账号>/<私有仓库名>.git
   git push -u origin main
   ```
2. 打开仓库的 **Actions** 页面，允许工作流运行（私有仓库默认允许）。

**每次打包**

1. 仓库 → **Actions** → 左侧点「**打 Mac 安装包**」→ 右侧 **Run workflow**
2. 选 `l`（仅通用种子）或 `hk`（全量种子）→ 运行
3. 等约 10–20 分钟 → 点进这次运行 → 页面底部 **Artifacts** 下载
4. 解压得到：`Nova-Studio-L-<版本>-mac-arm64.dmg`、`-mac-x64.dmg`、两个 `.zip`、`l-mac.yml`

**额度**：私有仓库每月 2000 分钟，macOS 运行器按 **10 倍**计费 → 大约能打 10–15 次/月。
打出来的包**同样是未签名**（限制见第四节）。

**拿到 dmg 之后**：直接发给同事安装；要发布到你的 Release 仓库（让客户端能自动更新）时，
把 dmg/zip/`-mac.yml` 一起上传即可（`publish-release.sh` 已支持这几个文件名，会自动带上）。
