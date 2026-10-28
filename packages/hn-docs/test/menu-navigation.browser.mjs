import assert from "node:assert/strict";

/** 使用 ego-browser 的现有 Page 运行；不清 Cookie、不修改文档数据。 */
export async function verifyMenuNavigation(page, baseId, menuId) {
  const root = `http://localhost:3004/yddoc/${encodeURIComponent(baseId)}/zh-cn`;
  let checks = 0;
  for (const path of [root, `${root}/${encodeURIComponent(menuId)}`]) {
    await page.goto(`${path}?from=boss`);
    await page.waitForSelector("loc=css:.ant-tree-title");
    const before = await page.evaluate(() => [...document.querySelectorAll(".ant-tree-title")].map((node) => node.textContent));
    for (let round = 0; round < 3; round++) {
      await page.evaluate(() => {
        window.__menuNavigationComplete = false;
        const done = () => {
          window.__menuNavigationComplete = true;
          window.next.router.events.off("routeChangeComplete", done);
        };
        window.next.router.events.on("routeChangeComplete", done);
      });
      await page.click('loc=css:.ant-tree-title >> nth=0');
      await page.waitForFunction(() => window.__menuNavigationComplete);
      await page.waitForSelector("loc=css:.ant-tree-title");
      const after = await page.evaluate(() => ({
        query: window.next.router.query,
        titles: [...document.querySelectorAll(".ant-tree-title")].map((node) => node.textContent),
      }));
      assert.equal(after.query.brandCode, baseId, "点击后必须保留知识库参数，不能变为 _next");
      assert.equal(after.query.languageCode, "zh-cn", "点击后必须保留语言参数，不能变为 data");
      assert.deepEqual(after.query.param, [menuId], "点击后必须指向原文档 ID");
      assert.deepEqual(after.titles, before, "目录不能因切换路由消失");
      checks++;
    }
  }
  return { checks, result: "首页进入文档、文档内重复点击均保持路由参数与左侧目录" };
}
