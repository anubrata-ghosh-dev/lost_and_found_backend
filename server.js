require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { db } = require("./firebase");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* ===================== SUPABASE ===================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ===================== MULTER ===================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* ===================== GLOBAL MIDDLEWARE ===================== */
app.use(cors());
app.use(express.json());

/* ===================== MATCHING LOGIC ===================== */
function isPossibleMatch(lost, found) {
  if (lost.category !== found.category) return false;

  const lostDate = new Date(lost.date_lost);
  const foundDate = new Date(found.date_found);
  const diffDays = Math.abs(lostDate - foundDate) / (1000 * 60 * 60 * 24);
  if (diffDays > 7) return false;
/*new*/
  return found.location_found
    .toLowerCase()
    .split(",")
    .map(p=>p.trim());
    return lostPlaces.some(place=>found.location_found.toLowerCase().include(place));
  /*new*/  
}

function tokenize(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function keywordScore(foundDesc = "", verifyText = "") {
  const a = tokenize(foundDesc);
  const b = tokenize(verifyText);
  return b.filter(x => a.includes(x)).length;
}

/* ===================== HEALTH ===================== */
app.get("/", (_, res) => {
  res.send("Lost & Found backend running");
});

/* ===================== POST FOUND ITEM ===================== */
app.post("/found", upload.single("itemImage"), async (req, res) => {
  try {
    if (!req.body.finderContact) {
      return res.status(400).json({
        error: "Finder email is required"
      });
    }

    let imagePath = null;

    if (req.file) {
      const fileName = `found-${Date.now()}-${req.file.originalname}`;

      const { error } = await supabase.storage
        .from("found-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        });

      if (!error) imagePath = fileName;
    }

    const foundItem = {
      category: req.body.category,
      date_found: req.body.dateFound,
      location_found: req.body.location,
      description: req.body.description || "",
      image_path: imagePath,
      finder_email: req.body.finderContact,
      status: "open",
      created_at: new Date()
    };

    const foundRef = await db.collection("found_items").add(foundItem);

    // 🔍 check existing lost items
    const lostSnap = await db
      .collection("lost_items")
      .where("status", "==", "open")
      .get();

    let matchedLostEmail = null;

    for (const doc of lostSnap.docs) {
      if (isPossibleMatch(doc.data(), foundItem)) {
        matchedLostEmail = doc.data().user_email;

        await db.collection("matches").add({
          lost_item_id: doc.id,
          found_item_id: foundRef.id,
          status: "verified",
          created_at: new Date()
        });

        break;
      }
    }

    res.status(201).json({
      saved: true,
      lost_owner_email: matchedLostEmail
    });

  } catch (err) {
    console.error("FOUND ERROR:", err);
    res.status(500).json({ error: "Found item failed" });
  }
});

/* ===================== FOUND LIST ===================== */
app.get("/found-with-status", async (_, res) => {
  try {
    const foundSnap = await db
      .collection("found_items")
      .orderBy("created_at", "desc")
      .get();

    const matchSnap = await db.collection("matches").get();

    const statusMap = {};
    matchSnap.forEach(doc => {
      const { found_item_id, status } = doc.data();
      statusMap[found_item_id] = status;
    });

    res.json(
      foundSnap.docs.map(d => ({
        id: d.id,
        category: d.data().category,
        date_found: d.data().date_found,
        match_status: statusMap[d.id] || "none"
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

/* ===================== POST LOST ITEM ===================== */
app.post("/lost", async (req, res) => {
  try {
    const lostItem = {
      category: req.body.category,
      description: req.body.description || "",
      location_lost: req.body.location,
      date_lost: req.body.dateLost,
      user_email: req.body.email,
      status: "open",
      created_at: new Date()
    };

    const lostRef = await db.collection("lost_items").add(lostItem);

    const foundSnap = await db
      .collection("found_items")
      .where("status", "==", "open")
      .get();

    let matchedFoundId = null;

    for (const doc of foundSnap.docs) {
      if (isPossibleMatch(lostItem, doc.data())) {
        matchedFoundId = doc.id;

        await db.collection("matches").add({
          lost_item_id: lostRef.id,
          found_item_id: doc.id,
          status: "pending",
          created_at: new Date()
        });

        break;
      }
    }

    res.status(201).json({
      saved: true,
      matched_found_item_id: matchedFoundId
    });

  } catch (err) {
    console.error("LOST ERROR:", err);
    res.status(500).json({ error: "Lost item failed" });
  }
});

/* ===================== CLAIM ===================== */
app.post("/claim", async (req, res) => {
  try {
    const { foundItemId, color, mark, extra } = req.body;

    const foundSnap = await db.collection("found_items").doc(foundItemId).get();
    if (!foundSnap.exists) return res.json({ approved: false });

    const found = foundSnap.data();

    const score = keywordScore(
      found.description,
      `${color} ${mark} ${extra || ""}`
    );

    if (score < 1) return res.json({ approved: false });

    const matchSnap = await db
      .collection("matches")
      .where("found_item_id", "==", foundItemId)
      .where("status", "==", "pending")
      .get();

    let lostEmail = null;

    for (const m of matchSnap.docs) {
      await m.ref.update({ status: "verified" });

      const lostDoc = await db
        .collection("lost_items")
        .doc(m.data().lost_item_id)
        .get();

      lostEmail = lostDoc.data()?.user_email || null;
    }

    // ✅ CREATE SIGNED IMAGE URL
    let signedUrl = null;
    if (found.image_path) {
      const { data } = await supabase.storage
        .from("found-images")
        .createSignedUrl(found.image_path, 600);

      signedUrl = data?.signedUrl || null;
    }

    res.json({
      approved: true,
      finder_email: found.finder_email,
      loser_email: lostEmail,
      signed_url: signedUrl
    });

  } catch (err) {
    console.error("CLAIM ERROR:", err);
    res.status(500).json({ approved: false });
  }
});
/* ===================== START ===================== */
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});