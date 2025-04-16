import express from 'express';  // `require` を `import` に変更
import line from '@line/bot-sdk';  // 同様に `import` を使用
import low from 'lowdb';  // `require` を `import` に変更
import { FileSync } from 'lowdb/adapters';  // `require` を `import` に変更
import schedule from 'node-schedule';  // `import` を使用
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();
app.use(express.json());

const adapter = new JSONFile('db.json');
const db = new Low(adapter);

// 初期化
async function initDB() {
  await db.read();
  db.data ||= { users: {}, keywords: {}, idResponses: {} };
  await db.write();
}

const withTimeout = (fn, ms = 5000) => (...args) =>
  Promise.race([
    fn(...args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    )
  ]);

// ユーザー初期化
async function ensureUser(userId) {
  if (!db.data.users[userId]) {
    db.data.users[userId] = {
      coin: 20,
      role: 'ノーマルメンバー'
    };
    await db.write();
  }
}
// 権限順位マップ
const ROLES = ['ブラックメンバー', 'ノーマルメンバー', '副管理者', '管理者', '運営者'];

function roleRank(role) {
  return ROLES.indexOf(role);
}

function isAuthorized(userId, minRole) {
  const user = db.data.users[userId];
  return user && roleRank(user.role) >= roleRank(minRole);
}

// === LINEメッセージ受信 ===
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await initDB();
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.sendStatus(500);
  }
});

// === メインイベントハンドラ ===
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const message = event.message.text.trim();
  await ensureUser(userId);
  const user = db.data.users[userId];

  // ブラックメンバーは無視
  if (user.role === 'ブラックメンバー') return;

  // キーワード応答
  const keywordReply = db.data.keywords[message];
  if (keywordReply) {
    await client.replyMessage(event.replyToken, { type: 'text', text: keywordReply });
    return;
  }

  // ID応答
  if (db.data.idResponses[userId]) {
    await client.replyMessage(event.replyToken, { type: 'text', text: db.data.idResponses[userId] });
    return;
  }

  // コマンド分岐
  if (message.startsWith('check')) return handleCheck(event, message);
  if (message === '情報') return handleInfo(event);
  if (message === 'スロット') return handleSlot(event);
  if (message === 'おみくじ') return handleOmikuji(event);
  if (message.startsWith('chat:')) return handleChatSet(event, message);
  if (message.startsWith('notchat:')) return handleChatDelete(event, message);
  if (message.startsWith('key:')) return handleKeySet(event, message);
  if (message === 'notkey') return handleKeyReset(event);
  if (message.startsWith('check:')) return handleCheckID(event, message);
  if (message === '権限者一覧') return handleAllRoles(event);
  if (message.startsWith('givebu:')) return handleBlackAdd(event, message);
  if (message.startsWith('notgivebu:')) return handleBlackRemove(event, message);
  if (message.startsWith('副官付与:')) return handleSubAdd(event, message);
  if (message.startsWith('副官削除:')) return handleSubRemove(event, message);
  if (message === 'ブラックリスト一覧') return handleBlackList(event);
  if (message.startsWith('coingive:')) return handleCoinGive(event, message);
  if (message.startsWith('allcoingive:')) return handleCoinAllGive(event, message);
  if (message.startsWith('notcoingive:')) return handleCoinRemove(event, message);
  if (message.startsWith('管理者付与:')) return handleAdminAdd(event, message);
  if (message.startsWith('管理者削除:')) return handleAdminRemove(event, message);
  if (message === '参加者一覧') return handleAllUsers(event);
}
// 5. check：自分 or リプライ先のID送信
async function handleCheck(event, message) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const replyId = event.reply?.replyTo?.userId;

  const targetId = (event.reply && event.reply.replyToken) ? replyId : userId;
  const idText = `あなたのIDは ${targetId || userId} です。`;
  await client.replyMessage(replyToken, { type: 'text', text: idText });
}

// 6. 情報：ID, コイン, 権限
async function handleInfo(event) {
  const userId = event.source.userId;
  const user = db.data.users[userId];
  const infoText = `あなたのID: ${userId}\nコイン: ${user.coin}枚\n権限: ${user.role}`;
  await client.replyMessage(event.replyToken, { type: 'text', text: infoText });
}

// 7. スロット
async function handleSlot(event) {
  const userId = event.source.userId;
  const user = db.data.users[userId];

  if (user.coin <= 0) {
    return await client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'コインが足りません。'
    });
  }

  user.coin -= 1;
  const num = () => Math.floor(Math.random() * 10);
  const a = num(), b = num(), c = num();
  const result = `${a}${b}${c}`;
  let reward = 0;
  if (a === b && b === c) {
    if (a === 7) reward = 500;
    else if ([1, 2, 3, 4, 5, 6, 8, 9].includes(a)) reward = 75;
  }

  user.coin += reward;
  await db.write();

  const msg = reward
    ? `${result} おめでとうございます！${reward}コイン当たり！\n残り${user.coin}コイン`
    : `${result} はずれ！！\n残り${user.coin}コイン`;

  await client.replyMessage(event.replyToken, { type: 'text', text: msg });
}

// 8. おみくじ
async function handleOmikuji(event) {
  const results = ['大吉', '中吉', '小吉', '吉', '末吉', '凶', '大凶'];
  const choice = results[Math.floor(Math.random() * results.length)];
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `おみくじの結果は……「${choice}」です！`
  });
}
// 9. chat:ID:メッセージ
async function handleChatSet(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  const parts = message.split(':');
  if (parts.length < 3) return;
  const targetId = parts[1];
  const replyText = parts.slice(2).join(':');
  db.data.idResponses[targetId] = replyText;
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} に対して「${replyText}」と返すようにしました。`
  });
}

// 10. notchat:ID
async function handleChatDelete(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  const targetId = message.replace('notchat:', '').trim();
  delete db.data.idResponses[targetId];
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} のID応答を削除しました。`
  });
}

// 11. key:A:B
async function handleKeySet(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  const match = message.match(/^key:(.+?):(.+)$/);
  if (!match) return;
  const trigger = match[1].trim();
  const response = match[2].trim();
  db.data.keywords[trigger] = response;
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `キーワード「${trigger}」に対して「${response}」と返すようにしました。`
  });
}

// 12. notkey
async function handleKeyReset(event) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  db.data.keywords = {};
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'すべてのキーワード応答をリセットしました。'
  });
}

// 13. check:ID
async function handleCheckID(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  const targetId = message.replace('check:', '').trim();
  const target = db.data.users[targetId];
  if (!target) return;
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `ID: ${targetId}\nコイン: ${target.coin}枚\n権限: ${target.role}`
  });
}

// 14. 権限者一覧
async function handleAllRoles(event) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '副管理者')) return;

  const list = Object.entries(db.data.users)
    .map(([id, u]) => `ID: ${id} → ${u.role}`)
    .join('\n');
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: list || '登録者がいません。'
  });
}
// 15. givebu:ID → ブラックメンバー追加
async function handleBlackAdd(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '管理者')) return;

  const targetId = message.replace('givebu:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = 'ブラックメンバー';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} をブラックメンバーに追加しました。`
  });
}

// 16. notgivebu:ID → ブラックメンバー解除（ノーマルに戻す）
async function handleBlackRemove(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '管理者')) return;

  const targetId = message.replace('notgivebu:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = 'ノーマルメンバー';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} をブラックメンバーから外しました。`
  });
}

// 17. 副官付与:ID → 副管理者にする
async function handleSubAdminAdd(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '管理者')) return;

  const targetId = message.replace('副官付与:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = '副管理者';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} を副管理者に昇格しました。`
  });
}

// 18. 副官削除:ID → ノーマルに戻す
async function handleSubAdminRemove(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '管理者')) return;

  const targetId = message.replace('副官削除:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = 'ノーマルメンバー';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} の副管理者権限を削除しました。`
  });
}

// 19. ブラックリスト一覧
async function handleBlacklist(event) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '管理者')) return;

  const blackList = Object.entries(db.data.users)
    .filter(([, u]) => u.role === 'ブラックメンバー')
    .map(([id]) => id)
    .join('\n');

  const text = blackList || 'ブラックメンバーはいません。';
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text
  });
}
// 20. coingive:ID:数 → 指定IDにコイン付与
async function handleCoinGive(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const parts = message.split(':');
  if (parts.length < 3) return;
  const targetId = parts[1];
  const amount = parseInt(parts[2], 10);
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].coin += amount;
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} に ${amount}コイン付与しました。`
  });
}

// 21. allcoingive:数 → 全ユーザーに一括付与
async function handleAllCoinGive(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const amount = parseInt(message.replace('allcoingive:', ''), 10);
  Object.values(db.data.users).forEach(u => {
    if (u.role !== 'ブラックメンバー') {
      u.coin += amount;
    }
  });
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `全メンバーに ${amount}コイン付与しました。`
  });
}

// 22. notcoingive:ID:数 → 指定IDのコインを減らす（0未満にはしない）
async function handleCoinRemove(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const parts = message.split(':');
  if (parts.length < 3) return;
  const targetId = parts[1];
  const amount = parseInt(parts[2], 10);
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].coin = Math.max(0, db.data.users[targetId].coin - amount);
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} から ${amount}コイン減らしました。`
  });
}

// 23. 管理者付与:ID
async function handleAdminAdd(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const targetId = message.replace('管理者付与:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = '管理者';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} を管理者に昇格しました。`
  });
}

// 24. 管理者削除:ID
async function handleAdminRemove(event, message) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const targetId = message.replace('管理者削除:', '').trim();
  if (!db.data.users[targetId]) return;

  db.data.users[targetId].role = 'ノーマルメンバー';
  await db.write();
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${targetId} の管理者権限を削除しました。`
  });
}

// 25. 参加者一覧 → 全ユーザーID、権限、コインを送信
async function handleAllMembers(event) {
  const userId = event.source.userId;
  if (!isAuthorized(userId, '運営者')) return;

  const list = Object.entries(db.data.users)
    .map(([id, u]) => `ID: ${id}\n権限: ${u.role}\nコイン: ${u.coin}枚\n`)
    .join('\n');

  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: list || 'ユーザーがいません。'
  });
}
