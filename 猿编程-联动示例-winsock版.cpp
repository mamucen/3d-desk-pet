// ============================================================
//   猿编程(C++) × 3D桌宠 联动示例【进阶版：纯 WinSock 实现】
//
//   和「猿编程-联动示例.cpp」功能完全一样，但不用调 curl 命令，
//   而是用 Windows 的 socket API 亲手发 HTTP 请求。
//   适合想搞懂「网络请求到底发生了什么」的同学。
//
//   注意：需要链接 ws2_32 库：
//   - Visual Studio：已用 #pragma comment 自动链接，直接编译
//   - Dev-C++ / 其他 MinGW IDE：编译参数加  -lws2_32
//     （项目属性 → 参数 → 链接器 里加上）
//   如果嫌麻烦，直接用普通版（curl 版）就行。
// ============================================================
#include <winsock2.h>
#include <ws2tcpip.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <iostream>

#pragma comment(lib, "ws2_32.lib")

static const int PET_PORTS[] = { 17321, 17322, 17323, 17324 };
static const int PORT_COUNT = 4;

static std::string escapeJson(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); i++) {
        char c = s[i];
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

// 亲手向 127.0.0.1:port 发一条 HTTP 请求，返回应答全文；失败返回空串
static std::string httpRequest(int port, const std::string& method,
                               const std::string& path,
                               const std::string& body) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return "";

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { WSACleanup(); return ""; }

    sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // 127.0.0.1，只找本机

    // 连不上 = 这个端口没有桌宠，返回空让上层试下一个端口
    if (connect(sock, (sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(sock);
        WSACleanup();
        return "";
    }

    // 手工拼 HTTP 报文：请求行、头、空行、正文
    std::string req = method + " " + path + " HTTP/1.1\r\n";
    req += "Host: 127.0.0.1\r\n";
    req += "Content-Type: application/json\r\n";
    req += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    req += "Connection: close\r\n";          // 说完就挂断，方便读完就收工
    req += "\r\n";
    req += body;

    send(sock, req.c_str(), (int)req.size(), 0);

    // 把应答全部读回来
    std::string resp;
    char buf[4096];
    int n;
    while ((n = recv(sock, buf, sizeof(buf), 0)) > 0) resp.append(buf, n);
    closesocket(sock);
    WSACleanup();
    return resp;
}

// 发指令并确认服务端返回了 200 OK
static bool requestOk(int port, const std::string& method,
                      const std::string& path, const std::string& body) {
    std::string resp = httpRequest(port, method, path, body);
    return resp.find("200") != std::string::npos;
}

// 四个超能力（挨个端口试，谁应答用谁）
static bool pet_say(const std::string& text) {
    std::string body = "{\"text\":\"" + escapeJson(text.substr(0, 200)) + "\"}";
    for (int i = 0; i < PORT_COUNT; i++)
        if (requestOk(PET_PORTS[i], "POST", "/pet/say", body)) return true;
    return false;
}
static bool pet_skin(const std::string& skinId) {
    std::string body = "{\"id\":\"" + escapeJson(skinId) + "\"}";
    for (int i = 0; i < PORT_COUNT; i++)
        if (requestOk(PET_PORTS[i], "POST", "/pet/skin", body)) return true;
    return false;
}
static bool pet_act(const std::string& action) {
    std::string body = "{\"action\":\"" + escapeJson(action) + "\"}";
    for (int i = 0; i < PORT_COUNT; i++)
        if (requestOk(PET_PORTS[i], "POST", "/pet/act", body)) return true;
    return false;
}
static std::string pet_ping() {
    for (int i = 0; i < PORT_COUNT; i++) {
        std::string resp = httpRequest(PET_PORTS[i], "GET", "/pet/ping", "");
        if (!resp.empty()) {
            // 应答是「HTTP头 + 空行 + 正文」，正文才是 JSON
            size_t p = resp.find("\r\n\r\n");
            if (p != std::string::npos) return resp.substr(p + 4);
        }
    }
    return "";
}

static int jsonInt(const std::string& json, const std::string& key) {
    std::string tag = "\"" + key + "\":";
    size_t p = json.find(tag);
    if (p == std::string::npos) return -1;
    p += tag.size();
    while (p < json.size() && json[p] == ' ') p++;
    if (p >= json.size() || json[p] < '0' || json[p] > '9') return -1;
    return std::atoi(json.c_str() + p);
}

int main() {
    std::string info = pet_ping();
    if (info.empty()) {
        std::cout << "没找到桌宠，先双击打开桌面上的「3D桌宠」再运行我。" << std::endl;
        return 1;
    }

    int cpu = jsonInt(info, "cpu");
    int mem = jsonInt(info, "mem");
    std::cout << "连上桌宠啦！CPU " << cpu << "%，内存 " << mem << "%" << std::endl;

    if (cpu > 80) {
        pet_skin("ghost");
        pet_say("CPU 都 80% 了，我变个幽灵给你降降温！");
    } else if (cpu > 50) {
        pet_skin("deepsea");
        pet_say("有点忙，我潜水冷静一下。");
    } else {
        pet_skin("samurai");
        pet_say("电脑很轻松！这把刀我先耍为敬。");
    }

    std::cout << "指令发完啦，去桌面上看看小机器人！" << std::endl;
    return 0;
}
