// 呼吸音聽音辨識測驗
var QUIZ_SOUNDS = [
  { id: "vesicular", audio: "vesicular.mp3", zh: "肺泡音", en: "Vesicular",
    exp_zh: "柔和、低音調，聽診於雙側肺野大部分區域，吸氣清楚、吐氣快速淡出。",
    exp_en: "Soft, low-pitched; heard over most of both lung fields, clear on inspiration and fading quickly on expiration." },
  { id: "bronchovesicular", audio: "bronchovesicular.mp3", zh: "支氣管肺泡音", en: "Bronchovesicular",
    exp_zh: "介於肺泡音與支氣管音之間，聽診於前胸第1–2肋間、兩側肩胛骨之間。",
    exp_en: "Intermediate between vesicular and bronchial sounds; heard over the 1st–2nd intercostal spaces and between the scapulae." },
  { id: "bronchial", audio: "bronchial.mp3", zh: "支氣管音", en: "Bronchial",
    exp_zh: "大聲、粗糙、音調偏高，正常聽診於氣管兩側附近；出現在周邊肺野則為異常。",
    exp_en: "Loud, harsh, relatively high-pitched; normal near the trachea, but abnormal if heard in the lung periphery." },
  { id: "crackles-fine", audio: "crackles_fine.mp3", zh: "細爆裂音", en: "Fine Crackles",
    exp_zh: "細碎、不連續，好發吸氣中後段，約650Hz，常見於肺纖維化，又稱Velcro rales。",
    exp_en: "Fine, discontinuous, mid-to-late inspiratory, ~650Hz — often heard in pulmonary fibrosis, aka \"Velcro rales.\"" },
  { id: "crackles-coarse", audio: "crackles_coarse.mp3", zh: "粗爆裂音", en: "Coarse Crackles",
    exp_zh: "較響亮低沉，約350Hz，從吸氣早期延續到吐氣，常隨咳嗽而改變。",
    exp_en: "Louder, lower-pitched, ~350Hz, spanning early inspiration into expiration — often changes with coughing." },
  { id: "wheezes", audio: "wheezes.mp3", zh: "喘鳴音", en: "Wheezes",
    exp_zh: "高音調、連續性、樂音樣，主頻率≥400Hz，氣喘發作的代表性聲音。",
    exp_en: "High-pitched, continuous, musical, ≥400Hz dominant frequency — the hallmark sound of asthma exacerbation." },
  { id: "rhonchi", audio: "rhonchi.mp3", zh: "鼾音", en: "Rhonchi",
    exp_zh: "低音調、打鼾樣的連續性聲音，約150–200Hz，常因咳嗽或抽痰而改變。",
    exp_en: "Low-pitched, snoring-like continuous sound, ~150–200Hz — often changes with coughing or suctioning." },
  { id: "stridor", audio: "stridor.mp3", zh: "哮鳴音", en: "Stridor",
    exp_zh: "高音調樂音樣連續性聲音，頸部最清楚，代表上呼吸道狹窄，屬呼吸道緊急警訊。",
    exp_en: "High-pitched, musical, continuous sound, loudest over the neck — indicates upper airway narrowing, an airway-emergency warning sign." },
  { id: "pleural-friction-rub", audio: "pleural_friction_rub.mp3", zh: "肋膜摩擦音", en: "Pleural Friction Rub",
    exp_zh: "粗糙、類似皮革摩擦的不連續聲音，常伴隨吸氣時的銳利胸痛。",
    exp_en: "Coarse, leathery, discontinuous sound, often accompanied by sharp inspiratory chest pain." },
];

var state = { order: [], current: 0, score: 0, answered: false };

function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function startQuiz() {
  state.order = shuffle(QUIZ_SOUNDS);
  state.current = 0;
  state.score = 0;
  document.getElementById("quiz-start").style.display = "none";
  document.getElementById("quiz-result").style.display = "none";
  document.getElementById("quiz-body").style.display = "block";
  loadQuestion();
}

function loadQuestion() {
  state.answered = false;
  var q = state.order[state.current];
  document.getElementById("q-num").textContent = state.current + 1;
  document.getElementById("q-num-en").textContent = state.current + 1;
  document.getElementById("q-bar").style.width = ((state.current) / QUIZ_SOUNDS.length * 100) + "%";

  var audioEl = document.getElementById("q-audio");
  audioEl.src = "../assets/audio/" + q.audio;
  audioEl.load();

  // build options: correct + 3 random distractors
  var distractors = shuffle(QUIZ_SOUNDS.filter(function (s) { return s.id !== q.id; })).slice(0, 3);
  var options = shuffle([q].concat(distractors));

  var optWrap = document.getElementById("q-options");
  optWrap.innerHTML = "";
  options.forEach(function (opt) {
    var btn = document.createElement("button");
    btn.className = "quiz-option";
    btn.innerHTML = '<span data-lang="zh">' + opt.zh + '</span><span data-lang="en">' + opt.en + '</span>';
    btn.onclick = function () { selectAnswer(opt, q, btn); };
    optWrap.appendChild(btn);
  });

  var fb = document.getElementById("q-feedback");
  fb.className = "quiz-feedback";
  fb.innerHTML = "";
  document.getElementById("next-btn").style.display = "none";
}

function selectAnswer(chosen, correct, btnEl) {
  if (state.answered) return;
  state.answered = true;
  var isCorrect = chosen.id === correct.id;
  if (isCorrect) state.score++;

  document.querySelectorAll(".quiz-option").forEach(function (b) { b.disabled = true; });
  btnEl.classList.add(isCorrect ? "correct" : "wrong");
  if (!isCorrect) {
    document.querySelectorAll(".quiz-option").forEach(function (b) {
      if (b.textContent.indexOf(correct.zh) !== -1) b.classList.add("correct");
    });
  }

  var fb = document.getElementById("q-feedback");
  fb.className = "quiz-feedback show " + (isCorrect ? "ok" : "no");
  fb.innerHTML =
    '<div data-lang="zh"><strong>' + (isCorrect ? "✅ 答對了！" : "❌ 答錯了，正確答案是「" + correct.zh + "」") + '</strong><br>' + correct.exp_zh + '</div>' +
    '<div data-lang="en"><strong>' + (isCorrect ? "✅ Correct!" : "❌ Not quite — the correct answer is \"" + correct.en + "\"") + '</strong><br>' + correct.exp_en + '</div>';

  document.getElementById("next-btn").style.display = "inline-block";
}

function nextQuestion() {
  state.current++;
  if (state.current >= QUIZ_SOUNDS.length) {
    showResult();
  } else {
    loadQuestion();
  }
}

function showResult() {
  document.getElementById("quiz-body").style.display = "none";
  document.getElementById("quiz-result").style.display = "block";
  document.getElementById("q-bar").style.width = "100%";
  var score = state.score, total = QUIZ_SOUNDS.length;
  document.getElementById("final-score").textContent = score + " / " + total;

  var pct = score / total;
  var msgZh, msgEn;
  if (pct === 1) { msgZh = "全對！對呼吸音的辨識掌握得很扎實。"; msgEn = "Perfect score! Your sound recognition is solid."; }
  else if (pct >= 0.7) { msgZh = "表現不錯，回教學頁複習答錯的項目會更扎實。"; msgEn = "Solid performance — review the ones you missed in the Learn section."; }
  else { msgZh = "多聽多練習，建議先回教學頁逐項複習聲學特性再重測。"; msgEn = "Keep practicing — revisit the Learn section for each sound's acoustic profile before retrying."; }
  document.getElementById("result-msg-zh").textContent = msgZh;
  document.getElementById("result-msg-en").textContent = msgEn;
}
