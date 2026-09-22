# Mac 版打包说明

## 一句话

**mac 的安装包必须在 Mac 上打**（`.dmg` 依赖苹果的 `hdiutil`/`codesign`，Windows 上做不出来；
硬拼出来的 zip 里 `.app` 的可执行权限是坏的，拿到 Mac 上双击打不开）。
Windows 上的 `Nova-Studio-HK/L-*.exe` 照旧，mac 版另出一套文件，两套并存不冲突。

---

## 一、在 Mac 上怎么打（3 步）

### 1. 装 Node.js

去 https://nodejs.org 下 **LTS 版（20 以上）**，一路下一步装完。
验证：打开「终端」输入 `node -v`，能打印版本号就行。

### 2. 把项目拷到 Mac

拷**整个 `nova-image-studio` 文件夹**（U 盘 / 网盘 / git 都行）。

- **不用拷 `node_modules`**（几百 MB，脚本会自己 `npm ci` 重装 Mac 版依赖）
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
bash publish-release.sh 3.4.1 l      # 只发 l 通道
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
| `npm ci` 卡住/报网络错 | 换国内镜像：`npm config set registry https://registry.npmmirror.com` 后重试 |
| 卡在下载 Electron | 加镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再跑 |
| 打包报签名相关错误 | 确认命令里带了 `CSC_IDENTITY_AUTO_DISCOVERY=false`（脚本已带） |
| 打开 dmg 里的 app 提示「已损坏」 | 未签名 + 下载来源标记 → `xattr -cr "/Applications/Nova Studio L.app"` |
