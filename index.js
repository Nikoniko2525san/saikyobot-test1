import express from 'express';
import { middleware, Client } from '@line/bot-sdk';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import cron from 'node-cron';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(config);
const app = express();
app.use(middleware(config));

const adapter = new JSONFile('./db.json');
const db = new Low(adapter);
await db.read();
db.data ||= { users: {}, keywords: {}, idResponses: {} };
await db.write();

const defaultUser = {
  coins: 20,
  role: 'ノーマルメンバー'
};

const roles = ['運営者', '管理者', '副管理者', 'ノーマルメンバー', 'ブラックメンバー'];

function getUser(userId) {
  db.data.users[userId] ||= { ...defaultUser };
  return db.data.users[userId];
}

function isAuthorized(userId, minRole) {
  const roleOrder = {
    'ブラックメンバー': -1,
    'ノーマルメンバー': 0,
    '副管理者': 1,
    '管理者': 2,
    '運営者': 3
  };
  const role = getUser(userId).role || 'ノーマルメンバー';
  return roleOrder[role] >= roleOrder[minRole];
}

async function reply(token, message) {
  await client.replyMessage(token, typeof message === 'string' ? { type: 'text', text: message } : message);
}

app.post('/webhook', async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// 毎日0時に全員へ20コイン配布
cron.schedule('0 0 * * *', async () => {
  for (const userId in db.data.users) {
    if (db.data.users[userId].role !== 'ブラックメンバー') {
      db.data.users[userId].coins += 20;
    }
  }
  await db.write();
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const { text } = event.message;
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  const user = getUser(userId);
  if (user.role === 'ブラックメンバー') return;

  // キーワード応答
  if (db.data.keywords[text]) {
    return reply(replyToken, db.data.keywords[text]);
  }

  // ID応答
  if (db.data.idResponses[userId]) {
    return reply(replyToken, db.data.idResponses[userId]);
  }

  const args = text.split(':');

  // --- 5. check ---
  if (text === 'check') {
    if (!isAuthorized(userId, 'ノーマルメンバー')) return;
    const replyId = event.reply?.userId || userId;
    return reply(replyToken, `あなたのIDは ${replyId} です`);
  }

  // --- 6. 情報 ---
  if (text === '情報') {
    if (!isAuthorized(userId, 'ノーマルメンバー')) return;
    return reply(replyToken, `ID: ${userId}\nコイン: ${user.coins}\n権限: ${user.role}`);
  }

  // --- 7. スロット ---
  if (text === 'スロット') {
    if (!isAuthorized(userId, 'ノーマルメンバー')) return;
    if (user.coins < 1) return reply(replyToken, 'コインが足りません');
    user.coins -= 1;
    const slot = [rand(), rand(), rand()];
    const result = slot.join('');
    let win = 0;
    if (slot[0] === slot[1] && slot[1] === slot[2]) {
      if (result === '777') win = 500;
      else win = 75;
      user.coins += win;
      await db.write();
      return reply(replyToken, `${result} 当たり！！${win}コイン獲得\n残り ${user.coins} コイン`);
    }
    await db.write();
    return reply(replyToken, `${result} はずれ！！\n残り ${user.coins} コイン`);
  }

  // --- 8. おみくじ ---
  if (text === 'おみくじ') {
    if (!isAuthorized(userId, 'ノーマルメンバー')) return;
    const fortunes = ['大吉', '中吉', '小吉', '末吉', '凶'];
    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)];
    return reply(replyToken, `あなたの運勢は・・・${fortune}！`);
  }

  // --- 9. chat:ID:メッセージ ---
  if (args[0] === 'chat' && isAuthorized(userId, '副管理者')) {
    const targetId = args[1];
    const message = args.slice(2).join(':');
    db.data.idResponses[targetId] = message;
    await db.write();
    return reply(replyToken, `ID応答を設定しました`);
  }

  // --- 10. notchat:ID ---
  if (args[0] === 'notchat' && isAuthorized(userId, '副管理者')) {
    delete db.data.idResponses[args[1]];
    await db.write();
    return reply(replyToken, `ID応答を削除しました`);
  }

  // --- 11. key:A:B ---
  if (args[0] === 'key' && isAuthorized(userId, '副管理者')) {
    db.data.keywords[args[1]] = args[2];
    await db.write();
    return reply(replyToken, `キーワード応答を登録しました`);
  }

  // --- 12. notkey ---
  if (text === 'notkey' && isAuthorized(userId, '副管理者')) {
    db.data.keywords = {};
    await db.write();
    return reply(replyToken, `キーワード応答を全削除しました`);
  }

  // 以下、13〜25や一覧系・管理コマンドなども含めて追加できます。続けて必要なら「続けて」と言ってください。
}
function rand() {
  return Math.floor(Math.random() * 9) + 1;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`LINE Bot running on ${port}`));
  // --- 13. check:ID ---
  if (args[0] === 'check' && args[1] && isAuthorized(userId, '副管理者')) {
    const target = getUser(args[1]);
    return reply(replyToken, `ID: ${args[1]}\n権限: ${target.role}\nコイン: ${target.coins}`);
  }

  // --- 14. 権限者一覧 ---
  if (text === '権限者一覧' && isAuthorized(userId, '副管理者')) {
    const result = Object.entries(db.data.users)
      .map(([id, u]) => `ID: ${id}\n権限: ${u.role}`)
      .join('\n\n');
    return reply(replyToken, result || '権限者がいません');
  }

  // --- 15. givebu:ID ---
  if (args[0] === 'givebu' && isAuthorized(userId, '管理者')) {
    getUser(args[1]).role = 'ブラックメンバー';
    await db.write();
    return reply(replyToken, `ブラックメンバーに設定しました`);
  }

  // --- 16. notgivebu:ID ---
  if (args[0] === 'notgivebu' && isAuthorized(userId, '管理者')) {
    getUser(args[1]).role = 'ノーマルメンバー';
    await db.write();
    return reply(replyToken, `ブラックメンバーを解除しました`);
  }

  // --- 17. 副官付与:ID ---
  if (args[0] === '副官付与' && isAuthorized(userId, '管理者')) {
    getUser(args[1]).role = '副管理者';
    await db.write();
    return reply(replyToken, `副管理者を付与しました`);
  }

  // --- 18. 副官削除:ID ---
  if (args[0] === '副官削除' && isAuthorized(userId, '管理者')) {
    getUser(args[1]).role = 'ノーマルメンバー';
    await db.write();
    return reply(replyToken, `副管理者を解除しました`);
  }

  // --- 19. ブラックリスト一覧 ---
  if (text === 'ブラックリスト一覧' && isAuthorized(userId, '管理者')) {
    const list = Object.entries(db.data.users)
      .filter(([_, u]) => u.role === 'ブラックメンバー')
      .map(([id]) => id);
    return reply(replyToken, list.length ? list.join('\n') : 'ブラックメンバーはいません');
  }

  // --- 20. coingive:ID:数 ---
  if (args[0] === 'coingive' && isAuthorized(userId, '運営者')) {
    const target = getUser(args[1]);
    const amount = parseInt(args[2]);
    if (!isNaN(amount)) {
      target.coins += amount;
      await db.write();
      return reply(replyToken, `${amount}コインを付与しました`);
    }
  }

  // --- 21. allcoingive:数 ---
  if (args[0] === 'allcoingive' && isAuthorized(userId, '運営者')) {
    const amount = parseInt(args[1]);
    for (const id in db.data.users) {
      if (db.data.users[id].role !== 'ブラックメンバー') {
        db.data.users[id].coins += amount;
      }
    }
    await db.write();
    return reply(replyToken, `全員に${amount}コインを配布しました`);
  }

  // --- 22. notcoingive:ID:数 ---
  if (args[0] === 'notcoingive' && isAuthorized(userId, '運営者')) {
    const target = getUser(args[1]);
    const amount = parseInt(args[2]);
    if (!isNaN(amount)) {
      target.coins = Math.max(0, target.coins - amount);
      await db.write();
      return reply(replyToken, `${amount}コインを減らしました（現在：${target.coins}枚）`);
    }
  }

  // --- 23. 管理者付与:ID ---
  if (args[0] === '管理者付与' && isAuthorized(userId, '運営者')) {
    getUser(args[1]).role = '管理者';
    await db.write();
    return reply(replyToken, `管理者を付与しました`);
  }

  // --- 24. 管理者削除:ID ---
  if (args[0] === '管理者削除' && isAuthorized(userId, '運営者')) {
    getUser(args[1]).role = 'ノーマルメンバー';
    await db.write();
    return reply(replyToken, `管理者を解除しました`);
  }

  // --- 25. 参加者一覧 ---
  if (text === '参加者一覧' && isAuthorized(userId, '運営者')) {
    const list = Object.entries(db.data.users)
      .map(([id, u]) => `ID: ${id}\n権限: ${u.role}\nコイン: ${u.coins}`)
      .join('\n\n');
    return reply(replyToken, list || '参加者はいません');
  }
}