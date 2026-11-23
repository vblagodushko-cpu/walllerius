const test = require("node:test");
const assert = require("node:assert/strict");
const { compactArticle, articleSearchKeys } = require("./articleKey");

test("дефіс і крапка не заважають збігу артикула", () => {
  assert.equal(compactArticle("08880-80845-BB"), "0888080845BB");
  assert.equal(compactArticle("0888080845-BB"), "0888080845BB");
  assert.equal(compactArticle("08880.80845.BB"), "0888080845BB");
  assert.equal(compactArticle(" kl 200 "), "KL200");
});

test("пошук питає і точну форму, і форму без розділювачів", () => {
  assert.deepEqual(articleSearchKeys("0888080845-BB"), ["0888080845-BB", "0888080845BB"]);
  assert.deepEqual(articleSearchKeys("0888080845BB"), ["0888080845BB"]);
});
