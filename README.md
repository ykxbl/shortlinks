# shortlinks
短链接生成器，部署在ESA容器上，纯Vibe Coding
**只有API**

# 使用说明
1. 在 ESA 控制台创建 KV 命名空间（例如 shortlinks）
2. 修改下方 SECRET_KEY 为你自己的密钥
3. 部署此函数并绑定域名或路由

# curl测试
生成
```curl
curl -X POST https://url/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.aliyun.com","ttl":86400,"key":"your_key"}'
```
删除
```curl
curl -X POST https://url/api/delete \
  -H "Content-Type: application/json" \
  -d '{"code":"path","key":"your_key"}'
```
