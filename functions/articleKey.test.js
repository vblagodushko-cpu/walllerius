const test = require("node:test");
const assert = require("node:assert/strict");
const { compactArticle, articleSearchKeys, suggestMasterCards } = require("./articleKey");

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

test("підказка майстра: префікс артикула попереду назви", () => {
  const cards = [
    { brand: "TOYOTA", id: "P999-10", correctName: "Олива P999", synonyms: [] },
    { brand: "TOYOTA", id: "08880-80845-BB", correctName: "Toyota A5/B5 5W-30", synonyms: ["0888080845BB"] },
    { brand: "PARTNER", id: "P999", correctName: "Чужий товар", synonyms: [] },
    { brand: "FUCHS", id: "ABC-1", correctName: "Інша олива", synonyms: ["P999X"] },
  ];
  const byPrefix = suggestMasterCards(cards, "p999");
  assert.deepEqual(byPrefix.map((item) => item.id), ["P999", "P999-10", "ABC-1"]);
  assert.equal(byPrefix[2].via, "synonym");
  const byName = suggestMasterCards(cards, "5w30");
  assert.equal(byName[0].id, "08880-80845-BB");
  assert.equal(byName[0].via, "name");
  const bySynonym = suggestMasterCards(cards, "0888080845");
  assert.equal(bySynonym[0].id, "08880-80845-BB");
  assert.equal(bySynonym[0].via, "article");
});
