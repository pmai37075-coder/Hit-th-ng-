const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8000;

// ====================== CẤU HÌNH ======================
const POLL_INTERVAL = 5000; // 5 giây
const RETRY_DELAY = 5000;
const MAX_HISTORY = 100;

// ====================== STORE ======================
let latest_result_100 = {
    Phien: 0,
    Xuc_xac_1: 0,
    Xuc_xac_2: 0,
    Xuc_xac_3: 0,
    Tong: 0,
    Ket_qua: "Chưa có",
    Tong_ChanLe: "Chưa có", // <--- NEW: Phân tích Chẵn/Lẻ
    TX_Pattern: "",
    Du_doan: "Chưa có", // Dự đoán theo Pattern cũ
    Du_doan_Streak: "Chưa có", // <--- NEW: Dự đoán theo Streak
    Dice_Bias: "Chưa có", // <--- NEW: Phân tích lệch xúc xắc
    id: "anhbantool1"
};

let history_100 = [];
let last_sid_100 = null;
let sid_for_tx = null;

// ====================== HÀM HỖ TRỢ PHÂN TÍCH CŨ ======================
function getTaiXiu(d1, d2, d3) {
    const total = d1 + d2 + d3;
    return total <= 10 ? "Xỉu" : "Tài";
}

function tinhPattern(history) {
    return history.slice(0, 10).map(h => h.Ket_qua === "Tài" ? "T" : "X").join('');
}

function duDoanTaiXiu(history) {
    if (history.length < 5) return "Chưa đủ dữ liệu";

    const pattern = history.slice().reverse().map(h => h.Ket_qua === "Tài" ? "T" : "X").join('');
    const last3 = pattern.slice(-3);

    let freq_T = 0;
    let freq_X = 0;

    for (let i = 0; i < pattern.length - 3; i++) {
        if (pattern.slice(i, i + 3) === last3) {
            const nextChar = pattern[i + 3];
            if (nextChar === "T") freq_T++;
            else freq_X++;
        }
    }

    if (freq_T > freq_X) return "Tài";
    else if (freq_X > freq_T) return "Xỉu";
    else {
        // Nếu bằng nhau, dự đoán đảo ngược kết quả gần nhất (một chiến lược đơn giản)
        const recent = history[0].Ket_qua;
        return recent === "Xỉu" ? "Tài" : "Xỉu";
    }
}

// ====================== HÀM HỖ TRỢ PHÂN TÍCH MỚI (AI) ======================

/**
 * Phân tích tổng là Chẵn (Even) hay Lẻ (Odd).
 */
function getChanLe(total) {
    return total % 2 === 0 ? "Chẵn" : "Lẻ";
}

/**
 * Phân tích tần suất các mặt xúc xắc (1-6) để tìm ra mặt Hot/Cold.
 */
function phanTichXucXac(history) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const N = Math.min(history.length, 50); // Chỉ phân tích 50 phiên gần nhất
    
    if (N === 0) return "Chưa đủ dữ liệu";

    for (let i = 0; i < N; i++) {
        const h = history[i];
        if (h.Xuc_xac_1) counts[h.Xuc_xac_1]++;
        if (h.Xuc_xac_2) counts[h.Xuc_xac_2]++;
        if (h.Xuc_xac_3) counts[h.Xuc_xac_3]++;
    }

    // Tìm mặt Hot và Cold
    let hot = 1;
    let cold = 1;
    
    for (let i = 2; i <= 6; i++) {
        if (counts[i] > counts[hot]) hot = i;
        if (counts[i] < counts[cold]) cold = i;
    }

    return `Hot: ${hot} (${counts[hot]}), Cold: ${cold} (${counts[cold]})`;
}

/**
 * Dự đoán theo chiến lược đảo ngược sau chuỗi (Streak Reversal).
 */
function duDoanStreak(history) {
    if (history.length < 3) return "Chờ đủ 3 phiên";

    const lastThree = history.slice(0, 3);
    const r1 = lastThree[0].Ket_qua;
    const r2 = lastThree[1].Ket_qua;
    const r3 = lastThree[2].Ket_qua;

    // Nếu có 3 kết quả liên tiếp giống nhau, dự đoán đảo ngược
    if (r1 === r2 && r2 === r3) { 
        return r1 === "Tài" ? "Xỉu (Reversal)" : "Tài (Reversal)"; 
    }
    
    // Nếu không, chờ đợi
    return "Chờ streak";
}

// ====================== HÀM UPDATE KẾT QUẢ CHÍNH ======================
function updateResult(store, history, result) {
    // Cập nhật các giá trị chính
    Object.assign(store, result);
    
    // Thêm kết quả vào lịch sử
    history.unshift({...result});
    if (history.length > MAX_HISTORY) history.pop();
    
    // Cập nhật các phân tích và dự đoán
    store.Tong_ChanLe = getChanLe(store.Tong); // <--- NEW
    store.TX_Pattern = tinhPattern(history);
    store.Du_doan = duDoanTaiXiu(history);
    store.Du_doan_Streak = duDoanStreak(history); // <--- NEW
    store.Dice_Bias = phanTichXucXac(history); // <--- NEW
}

// ====================== POLLING TÀI XỈU THƯỜNG ======================
async function pollTaiXiu() {
    const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100`;

    while (true) {
        try {
            const res = await axios.get(url, { headers: { 'User-Agent': 'Node-Proxy/1.0' }, timeout: 10000 });
            const data = res.data;

            if (data.status === 'OK' && Array.isArray(data.data)) {
                for (const game of data.data) {
                    const cmd = game.cmd;

                    if (cmd === 1008) {
                        sid_for_tx = game.sid;
                    }
                }

                for (const game of data.data) {
                    const cmd = game.cmd;

                    if (cmd === 1003) {
                        const sid = sid_for_tx;
                        const { d1, d2, d3 } = game;

                        if (sid && sid !== last_sid_100 && [d1, d2, d3].every(x => x != null)) {
                            last_sid_100 = sid;
                            const total = d1 + d2 + d3;
                            const ket_qua = getTaiXiu(d1, d2, d3);

                            const result = { 
                                Phien: sid, 
                                Xuc_xac_1: d1, 
                                Xuc_xac_2: d2, 
                                Xuc_xac_3: d3, 
                                Tong: total, 
                                Ket_qua: ket_qua, 
                                id: "anhbantool1" 
                            };
                            updateResult(latest_result_100, history_100, result);
                            console.log(`[TX] Phiên ${sid} | Tổng: ${total} (${latest_result_100.Tong_ChanLe}) | KQ: ${ket_qua} | Dự đoán Pattern: ${latest_result_100.Du_doan} | Dự đoán Streak: ${latest_result_100.Du_doan_Streak}`);
                            sid_for_tx = null;
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`Lỗi khi lấy dữ liệu TX:`, err.message);
            await new Promise(r => setTimeout(r, RETRY_DELAY));
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

// ====================== ROUTES ======================
app.get('/api/taixiu', (req, res) => {
    res.json(latest_result_100);
});

app.get('/api/history', (req, res) => {
    res.json({ taixiu: history_100 });
});

app.get('/', (req, res) => {
    res.send("🎲 API Server for TaiXiu thường is running. Endpoints: /api/taixiu, /api/history");
});

// ====================== START POLLING & SERVER ======================
console.log("🚀 Khởi động hệ thống TX thường...");
pollTaiXiu();

app.listen(PORT, () => {
    console.log(`✅ Server TX thường running on port ${PORT}`);
});
