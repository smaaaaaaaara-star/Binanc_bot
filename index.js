import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Trading Bot Server is Running 🚀");
});

app.get("/status", (req, res) => {
  res.json({ running: true });
});

app.listen(3000, () => {
  console.log("Server started on port 3000");
});
