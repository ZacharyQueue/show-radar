# 部署说明

演出雷达要一台在中国大陆网络里、一直开着的机器。按你手上有什么，选一种：

- 自己的电脑、能装 Node 的 NAS：用 `start` 或常驻模式 `daemon`，见“自己的电脑和 NAS”。
- Linux 云服务器：用安装脚本装成 systemd 定时器，见“Linux 服务器”。

两种都要先装 Node.js 22.13 或更新的版本。

## 装 Node.js

- 自己的电脑：到官网 `https://nodejs.org/` 下载 LTS 版本安装。官网慢，用国内镜像 `https://registry.npmmirror.com/-/binary/node/`，选 `v24.19.0` 这类目录。
- Linux 服务器：系统自带的 `apt install nodejs`、`yum install nodejs` 版本太旧，不能用；用 nvm 装在家目录里也不行，系统服务读不到。用 root 照下面装到 `/opt/node`（ARM 服务器把 `linux-x64` 换成 `linux-arm64`）：

  ```bash
  cd /tmp && curl -fsSLO https://registry.npmmirror.com/-/binary/node/v24.19.0/node-v24.19.0-linux-x64.tar.xz
  mkdir -p /opt/node && tar -xJf node-v24.19.0-linux-x64.tar.xz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ```

装好以后检查版本：

```bash
node -v
```

要 v22.13 或更新（23 要 23.4 以上）。版本太旧，运行会报找不到 `node:sqlite`。

## 自己的电脑和 NAS

1. 下载这个仓库，解压，打开终端进到仓库目录。
2. 启动：

   ```bash
   node src/cli.mjs start
   ```

3. 它会用浏览器打开本机网页。照 README 的“几分钟跑起来”，在网页里加艺人、配推送，再点“现在抓一轮”。

没有桌面的 NAS 用 `node src/cli.mjs daemon`，艺人和推送用命令行配，见 README 的“用命令行”。

终端窗口别关。要停就按 Ctrl+C：正在跑的那一轮会先把已经取到的存下再退出。艺人清单、状态库、密钥都在仓库下的 `.runtime/` 里，重新启动会接着跑。

几点要注意：

- **睡眠和关机。** 电脑睡眠、关机时不抓取，开售提醒也会晚。macOS 上可以用 `caffeinate -i node src/cli.mjs start`，跑着的时候不让电脑睡眠。
- **开机自动跑。** Windows 用“任务计划程序”，触发器选“登录时”，操作填 `node` 和 `src\cli.mjs daemon`，起始位置填仓库目录。要看网页时，另开一个终端运行 `node src\cli.mjs web`。
- **NAS。** 能装 Node 22.13 以上的 NAS 照上面做。Docker 的写法还没在真机上验证过，暂不提供。
- **更新。** 下载新版本解压到新目录，把旧目录里的 `.runtime/` 整个拷过去。用 `git clone` 的，直接 `git pull`：`.runtime/` 不在 Git 里。

本机网页怎么用，见 README 的“本机网页”。

## Linux 服务器

安装脚本建一个系统用户 `showradar`，代码放在 `/opt/show-radar`，装两个 systemd 定时器：抓取每 6 小时一轮，开售提醒每 10 分钟一次。定时器跑的程序不监听端口。

1. 用 root 登录服务器，下载这个仓库，进到仓库目录。
2. 打发布包，再安装：

   ```bash
   node scripts/pack.mjs
   ```

   它在 `artifacts/` 下打出 `show-radar-日期-时间.tar.gz`。

   ```bash
   bash deploy/install.sh artifacts/show-radar-日期-时间.tar.gz
   ```

   把文件名换成上一步打出来的那个。

3. 安装最后会跑一遍 `show-radar check`，看各平台从这台服务器能不能通。哪一行是“被拦”“连不上”，说明平台不让这台机器的 IP 访问，换一台机器或者改用自己的电脑。
4. 加艺人、配推送：

   ```bash
   show-radar follow 告五人、潘云安
   ```

   ```bash
   show-radar setup-push
   ```

安装脚本按这个顺序找 node：环境变量 `NODE`、`PATH` 里的 `node`、`/opt/node/bin/node`。node 装在家目录里（比如用 nvm 装的）不行，系统服务读不到，要装到 `/usr/local` 或 `/opt` 下。

### 平时

| 想做什么 | 命令 |
| --- | --- |
| 看在跟踪哪些演出 | `show-radar status` |
| 看各平台通不通 | `show-radar check` |
| 马上跑一轮 | `show-radar run` |
| 看最近几轮的日志 | `journalctl -u show-radar-run -n 100` |
| 看定时器下次什么时候跑 | `systemctl list-timers 'show-radar-*'` |

定时器那一轮正在跑时，手动的 `run` 会排队，等它跑完再跑。

想在自己电脑的浏览器里看网页，用 SSH 端口转发。登录服务器时带上转发，再在服务器上开网页：

```bash
ssh -L 7788:127.0.0.1:7788 root@服务器地址
show-radar web --no-open --port 7788
```

然后在自己的电脑上打开它打印的链接。网页还是只在服务器的 `127.0.0.1` 上，外网连不进来，不用开防火墙。服务器上没有桌面，`--no-open` 让它不去打开浏览器。

两边的端口要一样。服务器上 7788 被占了，`web` 会直接报错；两边一起换一个，比如 `ssh -L 7789:127.0.0.1:7789` 再 `show-radar web --no-open --port 7789`。自己电脑上 7788 被占了（比如本机也开着 `start`），SSH 会提示转发失败，同样两边换一个。看完按 Ctrl+C 关掉，定时器照常跑。

### 更新

下载新版本，重新打包、运行安装脚本。安装脚本能重复运行：换上新代码，状态库、艺人清单和推送密钥都不动。

### 文件在哪

| 内容 | 位置 |
| --- | --- |
| 代码 | `/opt/show-radar/current`，指向 `releases/` 里最新的一版，留最近 5 版 |
| 状态库 | `/opt/show-radar/shared/runtime/radar.sqlite` |
| 艺人清单 | `/opt/show-radar/shared/runtime/artists.txt` |
| 推送密钥 | `/opt/show-radar/shared/runtime/secrets.env`，只有 `showradar` 能读 |

## 企业微信

企业微信能把消息推进微信，但配置最麻烦。先看自己有没有下面这几样，缺一样就用邮件或 Server酱：

- 一台有固定公网 IP 的服务器。
- 一个备案过的域名，备案主体要和企业主体相同或有关联，而且这个域名上要有一个能访问的网站。企业微信要求先配好“可信域名”才能填可信 IP，配的时候要把它给的校验文件放到这个域名的根目录。本程序不提供网站，这一步要你自己的网页服务器（比如 nginx）来做。
- 企业要能对上域名的备案主体。没认证的企业，有人报告过“域名主体校验未通过”，基本过不了这一步。个人备案的域名配未认证的企业，大概率卡住。
- 另一条路是“接收消息服务器 URL”，要一个能应答企业微信校验的网页服务。本程序不对外监听端口（网页只听 `127.0.0.1`），走不了这条路。

1. 注册：打开 `https://work.weixin.qq.com/`，用手机号注册一个企业。企业名称要和域名的备案主体对得上，见上面第三条。
2. 建应用：电脑上登录管理后台，打开“应用管理 → 自建 → 创建应用”，可见范围选你自己。
3. 记下四样东西：
   1. 企业 ID：“我的企业 → 企业信息”最下面，`ww` 开头。
   2. AgentId：应用的页面上。
   3. Secret：同一页点“查看”，会发到你的企业微信里。
   4. 你的成员账号：“通讯录”里点自己，看“账号”那一栏。
4. 先在应用页面配好可信域名，再在“企业可信IP”里填服务器的公网 IP。没配的话，发消息会回错误码 60020。
5. 让微信收消息：“我的企业 → 微信插件”，用个人微信扫码关注。
6. 在服务器上运行 `show-radar setup-push`，选“企业微信”，填上面四样。

卡在第 4 步，就改用邮件或 Server酱。

## 常见问题

见 README 的“常见问题”。
