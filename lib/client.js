/**
 * dsh-mem-stars — browser half.
 *
 * 形态照星汐：侧栏 `sidebar.panellist` 放一个入口，`main` 槽位渲染整块星图。
 * 渲染复用记忆海那套 Canvas 2D（`public/sea.html`），通过 iframe 挂进来——
 * 这样渲染代码一行不用改，只换数据来源（`/dsh-mem-stars/scene`）。
 *
 * ⚠️ 经典 script，不是 ESM：window.__ModuleLoader__.load + factory(require)。
 * ⚠️ 导出必须是带 apply 的对象（空对象会让 web-boot 报 invalid plugin）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mem-stars',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    var VIEW = '/dsh-mem-stars/view'

    /** 侧栏入口：一颗小星星 */
    function Icon() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            fontSize: '15px',
            lineHeight: 1,
            userSelect: 'none',
          },
          title: '记忆星图：把 1911 条记忆摊成一片星海',
        },
        '✨',
      )
    }

    /** 主区域：整块星图 */
    function Panel() {
      return h('iframe', {
        src: VIEW,
        title: '记忆星图',
        style: {
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
          background: '#070912',
        },
      })
    }

    /** 错误边界：渲染炸了只显示错误，不白屏 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(e) {
        return { err: e }
      }
      componentDidCatch(e, info) {
        try {
          console.error('[mem-stars]', e, info)
        } catch {}
      }
      render() {
        if (this.state.err) {
          var e = this.state.err
          return h(
            'div',
            { style: { padding: 20, color: '#ff9a9a', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
            '星图渲染出错：',
            String((e && e.message) || e),
            String.fromCharCode(10, 10),
            String((e && e.stack) || '').slice(0, 800),
          )
        }
        return this.props.children
      }
    }

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    exports.name = 'dsh-mem-stars-client'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: 'mem-stars', order: 21, label: function () { return '星图' } },
          Icon,
        )
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          { name: 'main', key: 'mem-stars' },
          function () {
            return h(Boundary, null, h(Panel, null))
          },
        )
      })
    }

    return module.exports
  },
})
