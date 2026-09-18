// public/key-hold-tracker.js
//
// 「1フレーム内で押して離された打鍵をコアが取りこぼす」問題への対策。
//
// retro_input_poll は libretro の仕様上フレームごとに1回だけ呼ばれ、その直後に
// retro_input_state が(必要なキーの数だけ)呼ばれる。ゲスト（互換ROM）側は
// キーマトリクスを毎フレーム（VSYNC）走査して押下エッジを見るため、
// 「押した」→「離した」が同じフレームの retro_input_poll より前に両方届くと、
// コアは一度も「押されている」状態を観測できず、そのキーはまるで押されなかった
// ことになる（過去の教訓: release直後の再押下はinput_stateが未走行、
// 最低2ポーリングは押下を保つ）。
//
// 対策: keyup が来ても、そのキーが retro_input_poll によって MIN_POLLS 回
// 「押されている」と観測されるまでは実際の解放を保留する。保留中に同じキーの
// 押下→解放がさらに来た場合（連打）は取りこぼさずキューして、解放後に
// 最低1ポーリング分の「離した」ギャップを挟んでから次の押下を再現する
// （でないとコア側は1回の押しっぱなしとしか見えず、2文字目が入らない）。
//
// Worker（public/core-worker.js、classicスクリプトなので importScripts）と
// Node側のスモークテスト（scripts/smoke-app.cjs、CommonJS）の両方から
// 同じロジックを使うための共有モジュール。ロジックを二重化しない。
//
// 使い方:
//   var tracker = new KeyHoldTracker(minPolls);
//   // キー入力イベントが来たら:
//   tracker.press(id) / tracker.release(id)
//   // retro_set_input_poll のコールバック内で(フレームに1回だけ)呼ぶ:
//   tracker.beginPoll()
//   // retro_set_input_state のコールバック内で呼ぶ(副作用なし、何度呼んでもよい):
//   tracker.isPressed(id) -> boolean
//
// minPolls <= 0 を渡すと保留を完全に無効化し、押した/離した通りに即座に
// 反映する（=対策前の Set ベースの挙動と同じ）。陰性対照に使う。

(function (global) {
  'use strict';

  var DEFAULT_MIN_POLLS = 2;

  function KeyHoldTracker(minPolls) {
    this.minPolls = typeof minPolls === 'number' ? minPolls : DEFAULT_MIN_POLLS;
    this.states = new Map();
  }

  /** 内部: 押下が解放されたあと、キューされた押下があれば次サイクルへ、無ければ破棄する。 */
  KeyHoldTracker.prototype._advanceQueueOrRemove = function (id, s) {
    if (s.queuedPressCount > 0) {
      s.queuedPressCount--;
      s.waitingGap = true;
      s.obsWhileDown = 0;
    } else {
      this.states.delete(id);
    }
  };

  /** キー押下イベント。 */
  KeyHoldTracker.prototype.press = function (id) {
    var s = this.states.get(id);
    if (!s) {
      this.states.set(id, {
        down: true,
        obsWhileDown: 0,
        pendingRelease: false,
        queuedPressCount: 0,
        queuedReleaseCount: 0,
        waitingGap: false,
        needsRepress: false,
      });
      return;
    }
    if (s.down) {
      if (s.pendingRelease) {
        // 前回の押下がまだ解放待ちのうちに次の押下が来た → キューする(連打)
        s.queuedPressCount++;
      }
      // else: 押しっぱなし中の重複pressは無視
      return;
    }
    // down=false でエントリが残っている = ギャップ待ち/再押下待ちの途中
    s.queuedPressCount++;
  };

  /** キー解放イベント。 */
  KeyHoldTracker.prototype.release = function (id) {
    var s = this.states.get(id);
    if (!s) return;
    if (!s.down) {
      // まだ発火していないキュー済み押下に対する解放
      s.queuedReleaseCount++;
      return;
    }
    if (!s.pendingRelease) {
      // 現在アクティブな押下に対する解放
      if (this.minPolls <= 0 || s.obsWhileDown >= this.minPolls) {
        s.down = false;
        this._advanceQueueOrRemove(id, s);
      } else {
        s.pendingRelease = true;
      }
      return;
    }
    // pendingRelease が既に立っている = 今の押下の解放は記録済み。
    // これはキュー済み押下に対する解放。
    s.queuedReleaseCount++;
  };

  /**
   * retro_input_poll のコールバックから、フレームに1回だけ呼ぶ。
   * 保留中の状態をここでまとめて1ティック進める。
   */
  KeyHoldTracker.prototype.beginPoll = function () {
    if (this.states.size === 0) return;
    var self = this;
    this.states.forEach(function (s, id) {
      if (s.down) {
        s.obsWhileDown++;
        if (s.pendingRelease && s.obsWhileDown >= self.minPolls) {
          s.down = false;
          s.pendingRelease = false;
          self._advanceQueueOrRemove(id, s);
        }
        return;
      }
      if (s.waitingGap) {
        // 最低1ポーリング分「離れている」ことをゲストに見せるギャップ。
        s.waitingGap = false;
        s.needsRepress = true;
        return;
      }
      if (s.needsRepress) {
        s.needsRepress = false;
        s.down = true;
        s.obsWhileDown = 1;
        if (s.queuedReleaseCount > 0) {
          s.queuedReleaseCount--;
          s.pendingRelease = true;
          if (self.minPolls <= 0) {
            s.down = false;
            self._advanceQueueOrRemove(id, s);
          }
        } else {
          s.pendingRelease = false;
        }
      }
    });
  };

  /** retro_input_state から呼ぶ。副作用なし。 */
  KeyHoldTracker.prototype.isPressed = function (id) {
    var s = this.states.get(id);
    return !!(s && s.down);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KeyHoldTracker;
  } else {
    global.KeyHoldTracker = KeyHoldTracker;
  }
})(typeof self !== 'undefined' ? self : this);
