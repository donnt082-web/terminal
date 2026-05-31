/**
 * WebSocket 客户端封装
 * 提供连接管理、消息收发、事件监听功能
 */
class WSClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.clientId = null;
    this._listeners = {};
  }

  /**
   * 连接到 WebSocket 服务器
   * @param {string} address - 服务器地址
   * @param {number|string} port - 端口号
   */
  connect(address, port) {
    this.disconnect();

    const url = `ws://${address}:${port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this._emit('error', `创建连接失败: ${err.message}`);
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._emit('connected');
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.clientId = null;
      this._emit('disconnected');
    };

    this.ws.onerror = () => {
      // onclose 会随后触发
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch {
        this._emit('raw', event.data);
      }
    };
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.ws) {
      this.ws.onclose = null; // 防止触发自定义事件
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.clientId = null;
  }

  /**
   * 发送数据
   * @param {object|string} data
   * @returns {boolean} 是否发送成功
   */
  send(data) {
    if (!this.ws || !this.connected) return false;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
    return true;
  }

  /**
   * 注册事件监听
   * @param {string} event - 事件名: connected, disconnected, error, message, espData, ...
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
    return this;
  }

  /**
   * 移除事件监听
   */
  off(event, callback) {
    const cbs = this._listeners[event];
    if (!cbs) return;
    if (!callback) {
      delete this._listeners[event];
      return;
    }
    this._listeners[event] = cbs.filter(cb => cb !== callback);
  }

  // ── Internal ──

  _handleMessage(msg) {
    // Emit raw message
    this._emit('message', msg);

    // Emit specific type
    if (msg.type) {
      this._emit(msg.type, msg);
    }

    // Handle welcome message
    if (msg.type === 'welcome' && msg.clientId) {
      this.clientId = msg.clientId;
    }
  }

  _emit(event, data) {
    const cbs = this._listeners[event];
    if (cbs) {
      cbs.forEach(cb => {
        try { cb(data); } catch (err) {
          console.error(`[WSClient] 事件处理错误 (${event}):`, err);
        }
      });
    }
  }
}
