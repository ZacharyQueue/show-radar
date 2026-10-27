#!/usr/bin/env bash
# 演出雷达：在 Linux 服务器上安装或更新（docs/deploy.md）。能重复运行，每运行一次换上发布包里的新代码。
# 用 root 运行：bash install.sh 发布包.tar.gz
# 要用别的 node：NODE=/usr/local/bin/node bash install.sh 发布包.tar.gz
set -Eeuo pipefail

APP=/opt/show-radar
RUNTIME=$APP/shared/runtime
RUN_USER=showradar
BUNDLE=${1:-}

die() { echo "出错了：$*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[[ $EUID -eq 0 ]] || die "要用 root 运行。"
[[ -n $BUNDLE && -f $BUNDLE ]] || die "用法：bash install.sh 发布包.tar.gz"
command -v systemctl >/dev/null || die "这台机器没有 systemd。没有 systemd 的电脑和 NAS，用 node src/cli.mjs daemon 一直跑着，见 docs/deploy.md。"

# 找 node：先看 NODE 环境变量，再看 PATH，最后看 /opt/node
NODE=${NODE:-$(command -v node || true)}
[[ -z $NODE && -x /opt/node/bin/node ]] && NODE=/opt/node/bin/node
[[ -n $NODE && -x $NODE ]] || die "找不到 node。先装 Node.js 22.13 或更新的版本，或者用 NODE=node 的路径 bash install.sh 指明。"
NODE=$(readlink -f "$NODE")
case $NODE in
  /root/* | /home/*) die "node 装在家目录里（$NODE，常见于 nvm），系统服务读不到。把 Node 装到 /usr/local 或 /opt 下再装。" ;;
esac
# 直接试着加载 node:sqlite：22.13 以前、23.0 到 23.3 都要加开关才有
"$NODE" --no-warnings -e 'require("node:sqlite")' 2>/dev/null \
  || die "这个 Node 用不了内置的 SQLite：$("$NODE" -v)。换成 22.13 或更新的版本（23 要 23.4 以上）。"

step "1/6 建系统用户 $RUN_USER"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$RUNTIME" --shell /sbin/nologin "$RUN_USER"

step "2/6 建目录"
install -d -m 755 "$APP" "$APP/releases" "$APP/shared"
install -d -m 700 -o "$RUN_USER" -g "$RUN_USER" "$RUNTIME"

step "3/6 解压这一版代码"
REL=$APP/releases/$(date +%Y%m%d-%H%M%S)
mkdir -p "$REL"
tar -xzf "$BUNDLE" -C "$REL" --no-same-owner
[[ -f $REL/src/cli.mjs ]] || die "发布包里没有 src/cli.mjs，包打错了。"
chmod -R a+rX,go-w "$REL"
ln -sfn "$REL" "$APP/current.new"
mv -Tf "$APP/current.new" "$APP/current"
# 只留最近 5 版
ls -1dt "$APP"/releases/*/ | tail -n +6 | xargs -r rm -rf

step "4/6 艺人清单和推送密钥"
if [[ ! -f $RUNTIME/artists.txt ]]; then
  # 底稿开头那段“这是底稿”的说明（到第一行单独的 # 为止）不复制，和程序第一次运行时的做法一样
  if grep -qx '#' "$REL/config/artists.txt" && ! sed '/^#$/,$d' "$REL/config/artists.txt" | grep -qv '^\(#.*\)\?$'; then
    sed '1,/^#$/d' "$REL/config/artists.txt" > "$RUNTIME/artists.txt"
  else
    cat "$REL/config/artists.txt" > "$RUNTIME/artists.txt"
  fi
  chown "$RUN_USER:$RUN_USER" "$RUNTIME/artists.txt"
  chmod 600 "$RUNTIME/artists.txt"
  echo "艺人清单放在 $RUNTIME/artists.txt，用 show-radar follow 名字 加艺人。"
fi
if [[ ! -f $RUNTIME/secrets.env ]]; then
  printf '# 推送通道的密钥，用 show-radar setup-push 填\n' > "$RUNTIME/secrets.env"
  chown "$RUN_USER:$RUN_USER" "$RUNTIME/secrets.env"
  chmod 600 "$RUNTIME/secrets.env"
fi

step "5/6 装命令和定时器（node：$NODE）"
cat > /usr/local/bin/show-radar <<EOF
#!/usr/bin/env bash
# 以 $RUN_USER 身份运行演出雷达的命令，比如 show-radar status
# run 和 check 会发请求，程序自己用 $RUNTIME/run.lock 排队：定时器那一轮在跑时，手动的会等它跑完
exec runuser -u $RUN_USER -- env SHOW_RADAR_RUNTIME=$RUNTIME SHOW_RADAR_ARTISTS=$RUNTIME/artists.txt $NODE --no-warnings $APP/current/src/cli.mjs "\$@"
EOF
chmod 755 /usr/local/bin/show-radar
for unit in "$REL"/deploy/systemd/show-radar-*.service "$REL"/deploy/systemd/show-radar-*.timer; do
  sed "s#@NODE@#$NODE#g" "$unit" > "/etc/systemd/system/$(basename "$unit")"
  chmod 644 "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now show-radar-run.timer show-radar-remind.timer

step "6/6 看各数据源从这台服务器能不能通"
show-radar check || true

echo
echo "装好了。还没配推送的话，运行 show-radar setup-push。"
