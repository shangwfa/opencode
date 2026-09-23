我们是opencode saas 服务，基于PG数据库，对外提供接口，提供服务的

功能测试：

- 要在docker中启动服务
- 通过接口进行测试

opencode sass 作为一个code-agent ,主要负责跟AI打交道，通过各种工具，驱动任务的执行

- AI相关的工作由opencode saas服务承担
- 文件读写相关的，通过opensandbox 提供的沙箱支撑

主要流程：

- 用户创建会话
- 通过在沙箱中拉取代码仓库
- 用户完成需求开发
