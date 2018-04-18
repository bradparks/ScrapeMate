import browser from '../vendor/browser-polyfill.js'
import _ from 'lodash'
import Bus from './bus.js'
import Selector from './selector.js'

const SOURCES = {
	styles: ['vendor/selectorgadget_combined.css', 'content.css'],
	sidebarIFrame: 'sidebar.html'
}

let selectorGadget, sidebarIFrame
let bus = new Bus()
let jsDisabled = false


window.browser = browser
window.bus = bus


function disablePicker () {
	// TODO:low we might want to maintain sg instance and
	// just toggle it on and off instead of unsetting?

	if (!selectorGadget) return
	sidebarIFrame.classList.remove('ScrapeMate_picking')
	selectorGadget.unbindAndRemoveInterface()
	selectorGadget = null
	// on repeated initialization of SelectorGadget it doesn't unbind his events himself
	window.jQuerySG(document).add('*').unbind('.sg')
}

function enablePicker () {
	sidebarIFrame.classList.add('ScrapeMate_picking')
	selectorGadget = new SelectorGadget()
	selectorGadget.makeInterface()
	selectorGadget.clearEverything()
	selectorGadget.setMode('interactive')
	selectorGadget.sg_div[0].style = 'right: -9999px !important'
}

function onKeyUp (e) {
	if (selectorGadget) {
		// delegate to iframe
		e = _.pick(e, ['ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'repeat', 'keyCode', 'key'])
		bus.sendMessage('keyUp', e)
	}
}

function injectStyle(url) {
	// browser.tabs.insertCSS are non inspectable so we do CSS this way instead
	// although it is possible for our styles to be killed by the underlying webpage
    let el = document.createElement('link')
    el.rel = 'stylesheet'
    el.setAttribute('href', url)
    document.body.appendChild(el)
}

function initUI (cb) {
	// inject sidebar
	sidebarIFrame = document.createElement('iframe')
	sidebarIFrame.src = browser.extension.getURL(SOURCES.sidebarIFrame)
	sidebarIFrame.id = 'ScrapeMate'
    document.body.appendChild(sidebarIFrame)

	// setup event handlers
	window.addEventListener('keyup', onKeyUp)

	// setup communication with sidebar
	bus.attach(sidebarIFrame.contentWindow)
	bus.listeners = messageListeners
}

function toggleSelf () {
    if (document.querySelector('#ScrapeMate')) {
		// reattach to our currently existing scope and tell it to shutdown
		// TODO:medium silly
		messageListeners.close()
	} else {
		initUI()
	}
}

function main () {
	browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
		let [method, argument] = request
		if (method === 'onClicked') {
			toggleSelf()
		}
	})

	// inject styles
	SOURCES.styles.forEach(f => injectStyle(chrome.extension.getURL(f)));

	// init ui
	toggleSelf()

	// try to avoid selecting our own iframe
	if (!SelectorGadget.prototype.highlightIframeOrig)
		SelectorGadget.prototype.highlightIframeOrig = SelectorGadget.prototype.highlightIframe
	SelectorGadget.prototype.highlightIframe = function (elem, click) {
		if (elem[0] === sidebarIFrame) return
		return SelectorGadget.prototype.highlightIframeOrig.call(this, elem, click)
	}

	// hook into SelectorGadget selector update to send updates to our sidebar
	if (!SelectorGadget.prototype.sgMousedownOrig)
		SelectorGadget.prototype.sgMousedownOrig = SelectorGadget.prototype.sgMousedown
	SelectorGadget.prototype.sgMousedown = function (e) {
		let ret = SelectorGadget.prototype.sgMousedownOrig.call(this, e)
		let sel = selectorGadget.path_output_field.value
		bus.sendMessage('selectorPicked', sel)
		return ret
	}
}

// TODO:medium the name is bad and I don't like this whole thing
const messageListeners = {

	disablePicker: disablePicker,
	enablePicker: enablePicker,
	keyUp: onKeyUp,

	close: function () {
		bus.detach()
		window.removeEventListener('keyup', onKeyUp)
		disablePicker()
		document.body.removeChild(sidebarIFrame)
	},

	sidebarInitialized: function () {
		if (jsDisabled) bus.sendMessage('jsDisabled')
	},

	togglePosition: function () {
		sidebarIFrame.classList.toggle('ScrapeMate_left')
	},

    changeSelectorPicked: function (selector) {
		// replaces selector currently generated by SelectorGadget

        if (!selectorGadget) return
        selectorGadget.path_output_field.value = selector
        selectorGadget.refreshFromPath()
    },

    checkSelectors: function (selectors, respond) {
        let data = {}
        selectors.forEach(sel => {
			if (!sel) {
				data[sel] = 0
			} else {
				let [type,elems] = Selector.select(sel)
				data[sel] = type ? elems.length : -1
			}
		})
		respond(data)
	},

	saveText: function (text) {
		var el = document.createElement('a')
		el.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text))
		let dt = new Date().toISOString().split('T')[0]
		el.setAttribute('download', `ScrapeMate.storage.${dt}.json`)
		el.style.display = 'none'
		document.body.appendChild(el)
		el.click()
		document.body.removeChild(el)
	},

	location: function (data, respond) {
		respond(location.href)
	},

	disableJs: function () {
		fetch(location, {credentials: 'include'})
		.then(function (resp) {
			return resp.text()
		})
		.then(function (text) {
			document.documentElement.innerHTML = text
			injectCSS(SOURCES.sgCss)
			injectCSS(SOURCES.mainCss)
			bus.detach()
			jsDisabled = true
			initUI()
		})
	},

	loadStorage: function (arg, respond) {
		browser.storage.sync.get().then(respond)
	},

	removeStorageKeys: function (arg) {
		browser.storage.sync.remove(arg)
	},

	saveStorage: function (arg) {
		browser.storage.sync.set(arg)
	},

	getSelElemAttrs: function (selector, respond) {
		// selector -> [{attr:val, attr:val...}, ...]

		let selected = Selector.select(selector)[1]

		let elems = []
		_.forEach(selected, el => {
			let targetEl = Selector.asElementNode(el)

			let attrs = {}

			// AttrNode or TextNode
			if (el !== targetEl) attrs['_val'] = el.value || el.data

			_.forEach(targetEl.attributes, attr => {
				attrs[attr.name] = attr.value
			})

			let ownText = Selector.xpath('text()', targetEl).map(el => el.data)

			attrs['_tag'] = targetEl.tagName.toLowerCase()
			if (targetEl.innerHTML) attrs['_html'] = el.innerHTML
			if (ownText.length) attrs['_text'] = ownText

			if (attrs['class'])
				attrs['class'] = attrs['class'].replace(/\s*(ScrapeMate_\S+|selectorgadget_\S+)\s*/g, '')
			if (!attrs['class'])
				delete attrs['class']

			elems.push(attrs)
		})

		respond(elems)
	},

	highlight: function (selector) {
		this.unhighlight()
		_.forEach(Selector.select(selector)[1], el => {
			// TODO:low there should probably be an easier call that skips whole big css augmentation deal when we dont need it
			return Selector.asElementNode(el).classList.add('ScrapeMate_highlighted')
		})
    },

	unhighlight: function () {
		_.forEach(document.querySelectorAll('.ScrapeMate_highlighted'),
					el => el.classList.remove('ScrapeMate_highlighted'))
	}

}

main()
