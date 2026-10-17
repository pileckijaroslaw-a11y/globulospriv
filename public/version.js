// Nazwa i wersja gry. Zmieniaj TYLKO tutaj: napis w przeglądarce i w logach serwera bierze się z tego pliku.
(function (root) {
  const info = { NAME: "Kulki", VERSION: "1.2" };
  root.KulkiVersion = info;
  if (typeof module !== "undefined" && module.exports) module.exports = info;
})(typeof window !== "undefined" ? window : globalThis);
