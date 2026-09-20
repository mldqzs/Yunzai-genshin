/** 导入plugin */
import plugin from "../../../lib/plugins/plugin.js"
import gsCfg from "../model/gsCfg.js"
import common from "../../../lib/common/common.js"
import lodash from "lodash"
import fs from "node:fs"
import fetch from "node-fetch"

gsCfg.cpCfg("mys", "set")

/**
 * Modify By: ifeng0188
 * 1.增加多个来源的攻略图
 * 2.优化获取攻略图逻辑，更改为对比图片大小来寻找
 * 3.增加攻略说明、设置默认攻略功能
 *
 * 从拓展插件更新
 * 作者：曉K 更新：🌌
 */

export class strategy extends plugin {
  constructor() {
    super({
      name: "米游社攻略",
      dsc: "米游社攻略图",
      event: "message",
      priority: 50,
      rule: [
        {
          reg: "^[#*]?(更新)?(星铁)?\\S+攻略([1-7])?$",
          fnc: "strategy",
        },
        {
          reg: "^#?攻略(说明|帮助)?$",
          fnc: "strategy_help",
        },
        {
          reg: "^#?设置默认攻略([1-7])?$",
          fnc: "strategy_setting",
        },
      ],
    })

    this.set = gsCfg.getConfig("mys", "set")
    this.path = "./temp/strategy"
    this.url =
      "https://bbs-api.mihoyo.com/post/wapi/getPostFullInCollection?&gids=2&order_type=2&collection_id="
    this.srUrl =
      "https://bbs-api.mihoyo.com/post/wapi/getPostFullInCollection?gids=6&order_type=2&collection_id=1998324"
    this.collection_id = [
      [],
      [2319292, 2319293, 2319295, 2319296, 2319299, 2319294, 2319298, 642956],
      [813033],
      [341284],
      [341523],
      [1582613],
      [22148],
      [1812949],
    ]
    this.source = ["西风驿站", "原神观测枢", "派蒙喵喵屋", "OH是姜姜呀", "曉K", "坤易", "婧枫赛赛"]
    this.oss =
      "?x-oss-process=image//resize,s_1200/quality,q_90/auto-orient,0/interlace,1/format,jpg"
    this.srOss =
      "?x-oss-process=image//resize,s_600/quality,q_80/auto-orient,0/interlace,1/format,jpg"
  }

  /** 初始化创建配置文件 */
  async init() {
    for (let subId of [1, 2, 3, 4, 5, 6, 7]) {
      common.mkdirs(`${this.path}/gs/${subId}`)
    }
    common.mkdirs(`${this.path}/sr`)
  }

  /** #心海攻略 #星铁黄泉攻略 *黄泉攻略 */
  async strategy() {
    let match = /^[#*]?(更新)?(星铁)?(.+?)攻略([1-7])?$/.exec(this.e.msg)
    if (!match) return false

    let isUpdate = !!match[1]
    let isSr = this.e.msg.startsWith("*") || !!match[2] || this.e.isSr || this.e.game === "sr"
    let roleName = match[3]
    let group = match[4]

    if (isSr) return this.starRailStrategy(roleName, isUpdate)

    let role = gsCfg.getRole(roleName)
    if (!role) return false

    /** 主角特殊处理 */
    if (["10000005", "10000007", "20000000"].includes(String(role.roleId))) {
      let travelers = ["风主", "岩主", "雷主", "草主", "水主"]
      if (!travelers.includes(role.alias)) {
        let source = group || this.set.defaultSource
        await this.e.reply(`请选择：${travelers.map(name => `${name}攻略${source}`).join("、")}`)
        return true
      }
      role.name = role.alias
    }

    if (group) return this.sendGenshinSource(role.name, Number(group), isUpdate)
    return this.sendGenshinForward(role.name, isUpdate)
  }

  async sendGenshinSource(name, group, isUpdate) {
    let imgPath = this.getGenshinCachePath(name, group, isUpdate)
    if ((!fs.existsSync(imgPath) || isUpdate) && !(await this.getImg(name, group, imgPath))) return true

    let button = segment.button(
      [1, 2, 3, 4, 5, 6, 7].map(i => ({ text: String(i), callback: `#${name}攻略${i}` })),
    )
    await this.e.reply([segment.image(`file://${imgPath}`), button])
    return true
  }

  async sendGenshinForward(name, isUpdate) {
    let defaultGroup = Number(this.set.defaultSource)
    let groups = [1, 2, 3, 4, 5, 6, 7]
    if (groups.includes(defaultGroup)) {
      groups = [defaultGroup, ...groups.filter(group => group !== defaultGroup)]
    }

    let results = await Promise.allSettled(
      groups.map(async group => {
        let source = this.source[group - 1]
        let path = this.getGenshinCachePath(name, group, isUpdate)
        if (fs.existsSync(path) && !isUpdate) return { source, path }
        return await this.getImg(name, group, path, true) ? { source, path } : false
      }),
    )
    let msg = results
      .map(result => result.status === "fulfilled" && result.value
        ? [`${result.value.source}\n`, segment.image(`file://${result.value.path}`)]
        : false)
      .filter(Boolean)

    if (!msg.length) {
      await this.e.reply(`暂无${name}攻略数据，请稍后再试`)
      return true
    }
    await this.e.reply(await common.makeForwardMsg(this.e, msg, `${name}攻略 · 共找到${msg.length}个来源`))
    return true
  }

  /** 查询星铁米游社攻略 */
  async starRailStrategy(roleName, isUpdate) {
    let role = gsCfg.getRole(roleName, "星铁|攻略|更新", true)
    if (!role) return false

    let item
    try {
      let res = await this.getData(this.srUrl)
      if (res?.retcode !== 0 || !Array.isArray(res?.data?.posts)) {
        throw new Error(`接口响应异常：${res?.retcode ?? "unknown"}`)
      }
      let targetName = this.normalizeStarRailRoleName(role.name)
      item = res.data.posts
        .filter(val => this.getStarRailTitleRole(val?.post?.subject) === targetName)
        .sort(
          (a, b) =>
            Number(b.post.created_at || 0) - Number(a.post.created_at || 0) ||
            Number(b.post.post_id || 0) - Number(a.post.post_id || 0),
        )[0]
    } catch (error) {
      logger.error(`米游社星铁攻略接口报错：${error}`)
      await this.e.reply("暂无星铁攻略数据，请稍后再试")
      return true
    }

    if (!item) {
      await this.e.reply(`暂无${role.name}的星铁攻略，请稍后再试`)
      return true
    }

    let post = item.post
    let text = `${post.subject}\nhttps://www.miyoushe.com/sr/article/${post.post_id}`
    let url = this.getStarRailLongImage(item.image_list)
    if (!url) {
      logger.warn(`米游社星铁攻略缺少一图流：${post.post_id} ${post.subject}`)
      await this.e.reply(text)
      return true
    }

    await this.e.reply([`${text}\n`, segment.image(url + this.srOss)])
    return true
  }

  /** #攻略帮助 */
  async strategy_help() {
    await this.e.reply(
      "攻略帮助:\n#心海攻略（合并全部来源）\n#心海攻略[1234567]（指定来源）\n#更新心海攻略[1234567]\n#星铁黄泉攻略\n\n原神攻略来源:\n1——西风驿站\n2——原神观测枢\n3——派蒙喵喵屋\n4——OH是姜姜呀\n5——曉K\n6——坤易\n7——婧枫赛赛(角色配队一图流)",
    )
  }

  /** #设置默认攻略1 */
  async strategy_setting() {
    let match = /^#?设置默认攻略([1-7])?$/.exec(this.e.msg)
    let set = "./plugins/genshin/config/mys.set.yaml"
    let config = fs.readFileSync(set, "utf8")
    let num = Number(match[1])
    if (isNaN(num)) {
      await this.e.reply("默认攻略设置方式为: \n#设置默认攻略[1234567] \n 请增加数字1-7其中一个")
      return
    }
    config = config.replace(/defaultSource: [1-7]/g, "defaultSource: " + num)
    fs.writeFileSync(set, config, "utf8")
    await this.e.reply("默认攻略已设置为: " + match[1])
  }

  getGenshinCachePath(name, group, isUpdate = false) {
    let path = `${this.path}/gs/${group}/${name}.jpg`
    let legacyPath = `${this.path}/${group}/${name}.jpg`
    if (!isUpdate && !fs.existsSync(path) && fs.existsSync(legacyPath)) return legacyPath
    return path
  }

  /** 下载攻略图 */
  async getImg(name, group, imgPath, quiet = false) {
    let requests = this.collection_id[group].map(id => this.getData(this.url + id))
    let results = await Promise.allSettled(requests)
    let posts = lodash.flatten(
      results
        .filter(result => result.status === "fulfilled" && result.value)
        .map(result => result.value?.data?.posts || []),
    )
    let url = this.findGenshinImage(posts, name, group)

    if (!url) {
      if (!quiet) {
        await this.e.reply([
          `暂无${name}攻略（${this.source[group - 1]}）\n请尝试其他的攻略来源查询\n#攻略帮助，查看说明`,
          segment.button([{ text: "攻略帮助", callback: "#攻略帮助" }]),
        ])
      }
      return false
    }

    common.mkdirs(`${this.path}/gs/${group}`)
    logger.mark(`${this.e.logFnc} 下载${name}攻略图（${this.source[group - 1]}）`)
    if (!(await common.downFile(url + this.oss, imgPath))) return false
    logger.mark(`${this.e.logFnc} 下载${name}攻略成功`)
    return true
  }

  findGenshinImage(posts, name, group) {
    for (let val of posts) {
      if (group === 4 && val?.post?.structured_content?.includes(name + "】")) {
        let content = val.post.structured_content.replace(/\\\/\{\}/g, "")
        let pattern = new RegExp(name + '】.*?image\\\\?":\\\\?"(.*?)\\\\?"')
        let match = pattern.exec(content)
        let image = val.image_list?.find(item => item.image_id === match?.[1])
        if (image?.url) return image.url
      } else if (val?.post?.subject?.includes(name)) {
        let image = this.getLargestImage(val.image_list)
        if (image) return image
      }
    }
    return false
  }

  getLargestImage(images = []) {
    if (!Array.isArray(images) || !images.length) return false
    return images.reduce((max, image) => Number(image.size || 0) >= Number(max.size || 0) ? image : max).url
  }

  normalizeStarRailRoleName(name = "") {
    let normalized = name.trim().replace(/\s+/g, "").replace(/[•・]/g, "·").replace(/[—–-]/g, "·")
    let trailblazer = /^(穹|星)·(.+)$/.exec(normalized)
    if (trailblazer) return `开拓者·${trailblazer[2]}`
    return normalized
  }

  getStarRailTitleRole(subject = "") {
    let quoted = /「([^」]+)」/.exec(subject)
    let name = quoted?.[1]
    if (!name) name = subject.replace(/^.*?】/, "").split(/[丨|]/, 1)[0]
    return this.normalizeStarRailRoleName(name)
  }

  getStarRailLongImage(images = []) {
    if (!Array.isArray(images)) return false
    let candidates = images
      .filter(image => {
        let url = image?.url || ""
        let width = Number(image?.width || 0)
        let height = Number(image?.height || 0)
        return /^https?:\/\//.test(url) && !/\.gif(?:$|\?)/i.test(url) && width > 0 && height / width >= 4
      })
      .sort((a, b) => {
        let ratio = Number(b.height) / Number(b.width) - Number(a.height) / Number(a.width)
        return ratio || Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height)
      })
    return candidates[0]?.url || false
  }

  /** 获取数据 */
  async getData(url) {
    let controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), 15000)
    try {
      let response = await fetch(url, { method: "get", signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}
