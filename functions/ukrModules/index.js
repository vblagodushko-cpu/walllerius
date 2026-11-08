// functions/ukrModules/index.js — реєстр модулів синхронізації UkrSklad.
// Новий тип даних = новий файл-модуль { name, payloadSchema, apply } + рядок тут.
const docsFop = require("./docsFop");
const stockBeznal = require("./stockBeznal");
const productsMain = require("./productsMain");

const modules = {
  [docsFop.name]: docsFop,
  [stockBeznal.name]: stockBeznal,
  [productsMain.name]: productsMain,
};

module.exports = { modules };
