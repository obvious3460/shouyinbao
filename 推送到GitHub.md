# 如何把收银宝传到你的 GitHub（然后随时下载）

> 背景：这台开发机器的网络是隔离的（连不上 github.com / npm），
> 所以**无法在这里直接推送**。下面两种方法在**任何能上网的电脑**上操作即可，二选一。

---

## 方法一：网页直接上传（最简单，推荐）

1. 浏览器登录 https://github.com
2. 点右上角 `+` → **New repository**
   - Repository name 填：`shouyinbao`
   - 选 **Private**（私有，推荐）或 Public
   - 不要勾选 "Add a README"（保持空仓库），点 **Create repository**
3. 进入仓库后点 **uploading an existing file**
4. 把 `收银宝-服务端版.zip` 和 `收银宝-纯前端版.zip` 两个文件**拖进去**（zip 会以压缩包形式保存）
   —— 如果想把源码直接铺开显示，就先解压再**逐个上传文件夹里的文件**（网页支持一次拖多个）
5. 点 **Commit changes** 完成
6. 以后在任何设备上：打开仓库页面 → 点 **Code** → **Download ZIP** 即可下载

---

## 方法二：git 命令行推送（需要装 Git）

### 第 1 步：创建 GitHub 仓库
同上：github.com → `+` → New repository → 名字 `shouyinbao` → 勾 Private → 不勾 README → 创建。

### 第 2 步：生成访问令牌（Personal Access Token）
1. GitHub 右上角头像 → **Settings** → 左侧最下面 **Developer settings**
2. **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
3. Note 随便填（如 shouyinbao），有效期选 90 天，勾选 `repo` 权限
4. 点生成，**复制 token 字符串**（只显示一次，妥善保存）

### 第 3 步：推送
在能上网的电脑上打开终端，执行（**把里面的 `你的用户名` 换成你的 GitHub 用户名**）：

```bash
# 1. 解压
unzip 收银宝-服务端版.zip -d shouyinbao-server

# 2. 进入目录并初始化
cd shouyinbao-server
git init
git add .
git commit -m "收银宝服务端版：零依赖 Node + SQLite"

# 3. 关联你的仓库并推送（会提示输入用户名；密码栏粘贴第 2 步的 token）
git branch -M main
git remote add origin https://github.com/你的用户名/shouyinbao.git
git push -u origin main
```

> 也可以把 token 直接写进地址避免每次输入（**注意：token 会出现在命令历史里，用完建议去 GitHub 撤销重新生成**）：
> ```bash
> git remote add origin https://你的用户名:你的TOKEN@github.com/你的用户名/shouyinbao.git
> git push -u origin main
> ```

### 第 4 步：以后更新
改完文件后：
```bash
git add .
git commit -m "更新说明"
git push
```

---

## 小贴士
- 仓库设为 **Private**，别人看不到你的经营数据相关代码（虽然现在只是示例数据）。
- 下载到新电脑后，按 `执行方案.md` 第 3 节部署即可（装 Node.js → 启动服务）。
- 数据库文件 `data/shouyinbao.db` 是运行后自动生成的，**不建议**传到 GitHub（避免把真实经营数据传上网）；如需备份数据库，请直接复制 db 文件或走界面「下载数据库备份」。
