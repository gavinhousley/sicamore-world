const passwords = [
  { coords: "1 . 1 . 20", word: "kirsch" },
  { coords: "3 . 5 . 38", word: "galleons" },
  { coords: "5 . 5 . 4", word: "north" },
  { coords: "4 . 3 . 48", word: "planetarium" },
  { coords: "2 . 2 . 3", word: "enigmatic" },
];

const chosen = passwords[Math.floor(Math.random() * passwords.length)];
document.getElementById("coords").textContent = chosen.coords;

const validWords = passwords.map((p) => p.word);

document.getElementById("password").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    if (validWords.includes(this.value.trim().toLowerCase())) {
      window.location.href = "waste.html";
    } else {
      this.value = "";
    }
  }
});
