import { expect, test } from "vitest"
import { harnessSections, harnessPairs, harnessPairValues, parseCommand, parseJsonObject } from "./harness"

test("MCP 参数键值表保留值并拒绝空名称和重复名称", () => {
  const values = { Authorization: "Bearer secret", "X-Region": " region " }
  expect(harnessPairValues(harnessPairs(values))).toEqual(values)
  expect(harnessPairValues([{ key: "", value: "" }])).toEqual({})
  expect(() => harnessPairValues([{ key: "", value: "secret" }])).toThrow()
  expect(() => harnessPairValues([{ key: "Token", value: "1" }, { key: " Token ", value: "2" }])).toThrow()
})

test("管理页只展示 Agent、MCP、Skills、Commands", () => {
  expect(harnessSections.map((section) => section.id)).toEqual(["agents", "mcps", "skills", "commands"])
})

test("高级参数必须是 JSON 对象", () => {
  expect(parseJsonObject('{"steps":5}')).toEqual({ steps: 5 })
  for (const input of ["null", "[]", "5", "invalid"]) expect(() => parseJsonObject(input)).toThrow()
})
test("MCP 命令必须是非空字符串数组", () => {
  expect(parseCommand('["npx","-y","server"]')).toEqual(["npx", "-y", "server"])
  for (const input of ['"npx server"', "[]", '["npx",3]', '[""]']) expect(() => parseCommand(input)).toThrow()
})
