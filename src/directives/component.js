var _ = require('../util')
var templateParser = require('../parsers/template')

module.exports = {

  isLiteral: true,

  /**
   * Setup. Two possible usages:
   *
   * - static:
   *   v-component="comp"
   *
   * - dynamic:
   *   v-component="{{currentView}}"
   */

  bind: function () {
    if (!this.el.__vue__) {
      // create a ref anchor
      this.anchor = _.createAnchor('v-component')
      _.replace(this.el, this.anchor)
      // check keep-alive options.
      // If yes, instead of destroying the active vm when
      // hiding (v-if) or switching (dynamic literal) it,
      // we simply remove it from the DOM and save it in a
      // cache object, with its constructor id as the key.
      this.keepAlive = this._checkParam('keep-alive') != null
      // check ref
      this.refID = _.attr(this.el, 'ref')
      if (this.keepAlive) {
        this.cache = {}
      }
      // check inline-template
      if (this._checkParam('inline-template') !== null) {
        // extract inline template as a DocumentFragment
        this.template = _.extractContent(this.el, true)
      }
      // component resolution related state
      this._pendingCb =
      this.ctorId =
      this.Ctor = null
      // if static, build right now.
      if (!this._isDynamicLiteral) {
        this.resolveCtor(this.expression, _.bind(function () {
          var child = this.build()
          child.$before(this.anchor)
          this.setCurrent(child)
        }, this))
      } else {
        // check dynamic component params
        this.readyEvent = this._checkParam('wait-for')
        this.transMode = this._checkParam('transition-mode')
      }
    } else {
      _.warn(
        'v-component="' + this.expression + '" cannot be ' +
        'used on an already mounted instance.'
      )
    }
  },

  /**
   * Public update, called by the watcher in the dynamic
   * literal scenario, e.g. v-component="{{view}}"
   */

  update: function (value) {
    this.realUpdate(value)
  },

  /**
   * Switch dynamic components. May resolve the component
   * asynchronously, and perform transition based on
   * specified transition mode. Accepts an async callback
   * which is called when the transition ends. (This is
   * exposed for vue-router)
   *
   * @param {String} value
   * @param {Function} [cb]
   */

  realUpdate: function (value, cb) {
    this.invalidatePending()
    if (!value) {
      // just remove current
      this.unbuild()
      this.remove(this.childVM, cb)
      this.unsetCurrent()
    } else {
      this.resolveCtor(value, _.bind(function () {
        this.unbuild()
        var newComponent = this.build()
        var self = this
        if (this.readyEvent) {
          newComponent.$once(this.readyEvent, function () {
            self.swapTo(newComponent, cb)
          })
        } else {
          this.swapTo(newComponent, cb)
        }
      }, this))
    }
  },

  /**
   * Resolve the component constructor to use when creating
   * the child vm.
   */

  resolveCtor: function (id, cb) {
    var self = this
    this._pendingCb = _.cancellable(function (ctor) {
      self.ctorId = id
      self.Ctor = ctor
      cb()
    })
    this.vm._resolveComponent(id, this._pendingCb)
  },

  /**
   * When the component changes or unbinds before an async
   * constructor is resolved, we need to invalidate its
   * pending callback.
   */

  invalidatePending: function () {
    if (this._pendingCb) {
      this._pendingCb.cancel()
      this._pendingCb = null
    }
  },

  /**
   * Instantiate/insert a new child vm.
   * If keep alive and has cached instance, insert that
   * instance; otherwise build a new one and cache it.
   *
   * @return {Vue} - the created instance
   */

  build: function () {
    if (this.keepAlive) {
      var cached = this.cache[this.ctorId]
      if (cached) {
        return cached
      }
    }
    var vm = this.vm
    var el = templateParser.clone(this.el)
    if (this.Ctor) {
      var child = vm.$addChild({
        el: el,
        template: this.template,
        // if no inline-template, then the compiled
        // linker can be cached for better performance.
        _linkerCachable: !this.template,
        _asComponent: true,
        _host: this._host
      }, this.Ctor)
      if (this.keepAlive) {
        this.cache[this.ctorId] = child
      }
      return child
    }
  },

  /**
   * Teardown the current child, but defers cleanup so
   * that we can separate the destroy and removal steps.
   */

  unbuild: function () {
    var child = this.childVM
    if (!child || this.keepAlive) {
      return
    }
    // the sole purpose of `deferCleanup` is so that we can
    // "deactivate" the vm right now and perform DOM removal
    // later.
    child.$destroy(false, true)
  },

  /**
   * Remove current destroyed child and manually do
   * the cleanup after removal.
   *
   * @param {Function} cb
   */

  remove: function (child, cb) {
    var keepAlive = this.keepAlive
    if (child) {
      child.$remove(function () {
        if (!keepAlive) child._cleanup()
        if (cb) cb()
      })
    } else if (cb) {
      cb()
    }
  },

  /**
   * Actually swap the components, depending on the
   * transition mode. Defaults to simultaneous.
   *
   * @param {Vue} target
   * @param {Function} [cb]
   */

  swapTo: function (target, cb) {
    var self = this
    var current = this.childVM
    this.unsetCurrent()
    this.setCurrent(target)
    switch (self.transMode) {
      case 'in-out':
        target.$before(self.anchor, function () {
          self.remove(current, cb)
        })
        break
      case 'out-in':
        self.remove(current, function () {
          target.$before(self.anchor, cb)
        })
        break
      default:
        self.remove(current)
        target.$before(self.anchor, cb)
    }
  },

  /**
   * Set childVM and parent ref
   */
  
  setCurrent: function (child) {
    this.childVM = child
    var refID = child._refID || this.refID
    if (refID) {
      this.vm.$[refID] = child
    }
  },

  /**
   * Unset childVM and parent ref
   */

  unsetCurrent: function () {
    var child = this.childVM
    this.childVM = null
    var refID = (child && child._refID) || this.refID
    if (refID) {
      this.vm.$[refID] = null
    }
  },

  /**
   * Unbind.
   */

  unbind: function () {
    this.invalidatePending()
    this.unbuild()
    // destroy all keep-alive cached instances
    if (this.cache) {
      for (var key in this.cache) {
        this.cache[key].$destroy()
      }
      this.cache = null
    }
  }

}