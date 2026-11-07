// ============================================================
//   猿编程(C++) × 3D桌宠 联动示例
//
//   把整个文件的内容粘贴到猿编程的 C++ IDE 里编译运行，
//   桌面上的小机器人就会有反应！
//
//   原理：桌宠在本机开着一个小服务（127.0.0.1:17321），
//   我们用 Windows 10+ 自带的 curl 命令给它发 HTTP 指令。
//   不需要安装任何库，不需要改编译器设置。
//
//   运行前：先双击打开桌面上的「3D桌宠」。
// ============================================================
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <fstream>
#include <iostream>

// 桌宠可能占 17321~17324 中任意一个端口（被占用会自动换下一个）
static const int PET_PORTS[] = { 17321, 17322, 17323, 17324 };
static const int PORT_COUNT = 4;

// ---------- 小工具 ----------

// JSON 字符串转义：引号和反斜杠前加反斜杠，避免把指令撑破
static std::string escapeJson(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); i++) {
        char c = s[i];
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

// 用 POST 方式给桌宠发一条 JSON 指令。
// 成功返回 true。四个端口挨个试，谁应答用谁。
static bool httpPostJson(const std::string& path, const std::string& jsonBody) {
    // 先把 JSON 写进临时文件：避免命令行里引号转义的坑
    const char* tmpFile = "pet-cmd.tmp";
    {
        std::ofstream f(tmpFile, std::ios::binary);
        f << jsonBody;
    }
    for (int i = 0; i < PORT_COUNT; i++) {
        std::string cmd = "curl -s --max-time 3 -X POST"
                          " -H \"Content-Type: application/json\""
                          " --data-binary @" + std::string(tmpFile) +
                          " http://127.0.0.1:" + std::to_string(PET_PORTS[i]) + path +
                          " > nul 2>&1";
        if (std::system(cmd.c_str()) == 0) {
            std::remove(tmpFile);
            return true;              // 这个端口上的桌宠收到了！
        }
    }
    std::remove(tmpFile);
    return false;
}

// 用 GET 方式拿桌宠的应答文本（给 pet_ping 用）
static std::string httpGetText(const std::string& path) {
    for (int i = 0; i < PORT_COUNT; i++) {
        std::string cmd = "curl -s --max-time 3 http://127.0.0.1:" +
                          std::to_string(PET_PORTS[i]) + path;
        FILE* pipe = _popen(cmd.c_str(), "r");       // 读回命令的输出
        if (!pipe) continue;
        char buf[4096] = { 0 };
        size_t n = fread(buf, 1, sizeof(buf) - 1, pipe);
        int code = _pclose(pipe);
        if (code == 0 && n > 0) return std::string(buf, n);
    }
    return "";
}

// ---------- 四个超能力 ----------

// 让桌宠说话（头顶冒气泡；开着语音播报的话还会读出来）
static bool pet_say(const std::string& text) {
    std::string body = "{\"text\":\"" + escapeJson(text.substr(0, 200)) + "\"}";
    return httpPostJson("/pet/say", body);
}

// 给桌宠换皮肤：
// pixel / stellar / rich / camera / pubg / samurai / hotpot / deepsea / ghost
static bool pet_skin(const std::string& skinId) {
    std::string body = "{\"id\":\"" + escapeJson(skinId) + "\"}";
    return httpPostJson("/pet/skin", body);
}

// 现身 "show" / 隐身 "hide" / 跟随开关 "follow"
static bool pet_act(const std::string& action) {
    std::string body = "{\"action\":\"" + escapeJson(action) + "\"}";
    return httpPostJson("/pet/act", body);
}

// 问桌宠要电脑状态，返回 JSON 文本（里面有 cpu、mem、cores 等字段）
static std::string pet_ping() {
    return httpGetText("/pet/ping");
}

// 从 ping 的 JSON 里抠一个整数字段，比如 "cpu":23 里的 23
static int jsonInt(const std::string& json, const std::string& key) {
    std::string tag = "\"" + key + "\":";
    size_t p = json.find(tag);
    if (p == std::string::npos) return -1;
    p += tag.size();
    while (p < json.size() && json[p] == ' ') p++;
    if (p >= json.size() || json[p] < '0' || json[p] > '9') return -1;
    return std::atoi(json.c_str() + p);
}

// ---------- 试一试 ----------

int main() {
    std::string info = pet_ping();
    if (info.empty()) {
        std::cout << "没找到桌宠，先双击打开桌面上的「3D桌宠」再运行我。" << std::endl;
        return 1;
    }

    int cpu = jsonInt(info, "cpu");
    int mem = jsonInt(info, "mem");

    std::cout << "连上桌宠啦！CPU " << cpu << "%，内存 " << mem << "%" << std::endl;

    // 根据电脑负载换皮肤：越忙换越"警觉"的皮肤 :)
    if (cpu > 80) {
        pet_skin("ghost");      // 忙到冒烟，变幽灵飘一会儿
        pet_say("CPU 都 80% 了，我变个幽灵给你降降温！");
    } else if (cpu > 50) {
        pet_skin("deepsea");    // 有点压力，潜下水冷静一下
        pet_say("有点忙，我潜水冷静一下，CPU 50% 多了。");
    } else {
        pet_skin("samurai");    // 轻轻松松，耍个刀
        pet_say("电脑很轻松！我耍个刀先。");
    }

    std::cout << "指令发完啦，去桌面上看看小机器人！" << std::endl;
    return 0;
}
