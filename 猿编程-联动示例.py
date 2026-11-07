# -*- coding: utf-8 -*-
# ============================================================
#   猿编程 × 3D桌宠 联动示例
#
#   把整个文件粘贴到猿编程 IDE 里运行，桌宠就会有反应！
#   也可以只把下面的 4 个函数抄进你自己的代码里，随取随用。
#
#   用到的全是 Python 自带的标准库，不需要安装任何东西。
#   运行前：先双击打开桌面上的「3D桌宠」。
# ============================================================
import json
import urllib.request

# 桌宠可能占 17321~17324 中任意一个端口（被占用会自动换下一个），
# 所以挨个试，谁应答用谁。
PET_PORTS = [17321, 17322, 17323, 17324]


def _post(path, data):
    """给桌宠发一条 JSON 指令，返回它的应答。"""
    last_err = None
    for port in PET_PORTS:
        try:
            req = urllib.request.Request(
                'http://127.0.0.1:%d%s' % (port, path),
                data=json.dumps(data).encode('utf-8'),
                headers={'Content-Type': 'application/json'})
            resp = urllib.request.urlopen(req, timeout=3)
            return json.loads(resp.read().decode('utf-8'))
        except Exception as e:          # 这个端口没人听，试下一个
            last_err = e
    raise RuntimeError('没找到桌宠，先双击打开「3D桌宠」再试。(' + str(last_err) + ')')


def _get(path):
    last_err = None
    for port in PET_PORTS:
        try:
            resp = urllib.request.urlopen(
                'http://127.0.0.1:%d%s' % (port, path), timeout=3)
            return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            last_err = e
    raise RuntimeError('没找到桌宠，先双击打开「3D桌宠」再试。(' + str(last_err) + ')')


# ---------------- 四个超能力 ----------------

def pet_say(text):
    """让桌宠说话（头顶冒气泡，开语音的话还会读出来）。"""
    return _post('/pet/say', {'text': str(text)[:200]})


def pet_skin(skin_id):
    """给桌宠换皮肤：pixel/stellar/rich/camera/pubg/samurai/hotpot/deepsea/ghost"""
    return _post('/pet/skin', {'id': skin_id})


def pet_act(action):
    """现身 show / 隐身 hide / 跟随开关 follow"""
    return _post('/pet/act', {'action': action})


def pet_ping():
    """看看桌宠在不在线、电脑 CPU/内存多忙。"""
    return _get('/pet/ping')


# ---------------- 试一试：按顺序跑下面这几行 ----------------

if __name__ == '__main__':
    info = pet_ping()
    cpu = info['sys']['cpu']
    mem = info['sys']['mem']
    pet_say('你好！我是从猿编程的代码里跑出来的，电脑现在 CPU %d%%，内存 %d%%。' % (cpu, mem))

    # 根据电脑负载换皮肤：越忙换越“警觉”的皮肤 :)
    if cpu > 80:
        pet_skin('ghost')       # 忙到冒烟，变幽灵飘一会儿
    elif cpu > 50:
        pet_skin('deepsea')     # 有点压力，潜下水冷静一下
    else:
        pet_skin('samurai')     # 轻轻松松，耍个刀

    print('桌宠已收到指令！去桌面上看看它。')
