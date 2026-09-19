const http=require('http')
const s=http.createServer((req,res)=>{
if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<html><head><script src="/app.js"></script><link href="/style.css"></link></head><body><script>import "/helper.js";import x from "/mod.ts"</scr'+'ipt></body></html>')}
else if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end('import "/dep.js";import y from "/util.ts"')}
else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end('body{background:url(/img/bg.png)}')}
else{res.end('ok')}
});
s.listen(8080)
