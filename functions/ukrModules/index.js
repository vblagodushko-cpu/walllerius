// functions/ukrModules/index.js — реєстр модулів синхронізації UkrSklad.
// Новий тип даних = новий файл-модуль { name, payloadSchema, apply } + рядок тут.
const docsFop = require("./docsFop");
const stockBeznal = require("./stockBeznal");
const productsMain = require("./productsMain");
const settlements = require("./settlements");
const invoiceLines = require("./invoiceLines");
const currencyRates = require("./currencyRates");

const modules = {
  [invoiceLines.name]: invoiceLines,
  [settlements.name]: settlements,
  [docsFop.name]: docsFop,
  [stockBeznal.name]: stockBeznal,
  [productsMain.name]: productsMain,
  [currencyRates.name]: currencyRates,
};

module.exports = { modules };
