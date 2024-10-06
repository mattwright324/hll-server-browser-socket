'use strict';

const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const moment = require('moment');

const {Server} = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:4000", "https://mattw.io"],
        methods: ["GET", "POST"],
        allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept"],
    }
});

const { queryMasterServer, REGIONS, queryGameServerInfo, queryGameServerPlayer, queryGameServerRules} = require("steam-server-query")
const NodeCache = require("node-cache");
const masterTTL = moment.duration(7, 'days').asSeconds();
const checkperiod = moment.duration(1, 'minute').asSeconds();
const union = (arr) => {return [...new Set(arr.flat())]}

function base64ToHex(base64) {
    try {
        const raw = atob(base64);
        let result = '';
        for (let i = 0; i < raw.length; i++) {
            const hex = raw.charCodeAt(i).toString(16);
            result += (hex.length === 2 ? hex : '0' + hex);
        }
        return result.toUpperCase();
    } catch (e) {
        return "Err: " + base64
    }
}

const hex2bin = (hex) => hex.split('').map(i =>
    parseInt(i, 16).toString(2).padStart(4, '0')).join('');

function decodeGs(gsBase64) {
    const gsHex = base64ToHex(gsBase64);
    const gsBin = hex2bin(gsHex);

    let temp = gsBin;
    function readBin(len, desc) {
        const bits = temp.slice(0, len)
        temp = temp.slice(len)
        return parseInt(bits, 2)
    }

    readBin(2, "???");
    readBin(2, "_");
    const gamemode = readBin(4, "GameMode");
    readBin(8, "???");
    readBin(16, "???");
    const version = readBin(32, "Version");
    const players = readBin(7, "Players");
    const isOfficial = readBin(1, "Official");
    readBin(1, "_");
    const currentVip = readBin(7, "Curr VIP");
    readBin(1, "???");
    const maxVip = readBin(7, "Max VIP");
    readBin(2, "???");
    const currentQueue = readBin(3, "Curr Que");
    const maxQueue = readBin(3, "Max Que");
    readBin(4, "???");
    const isCrossplay = readBin(1, "Crss Play");
    const offensiveSide = readBin(3, "Off. Attk");
    const map = readBin(8, "Map");
    const timeOfDay = readBin(8, "Time o Day");
    const weather = readBin(8, "Weather");

    return {
        raw: gsBase64,
        bin: gsBin,
        decoded: {
            version: version,
            map: map,
            timeOfDay: timeOfDay,
            weather: weather,
            gamemode: gamemode,
            offensiveSide: offensiveSide,
            players: players,
            currentVip: currentVip,
            maxVip: maxVip,
            currentQueue: currentQueue,
            maxQueue: maxQueue,
            isOfficial: isOfficial === 1,
            isCrossplay: isCrossplay === 1,
        }
    }
}

const masterCache = new NodeCache({stdTTL: masterTTL, checkperiod: checkperiod});
masterCache.set("live_servers", []);
masterCache.set("pte_servers", []);
function masterServerQuery() {
    console.log("masterServerQuery()")

    function queryServersForAppId(appid, cacheKey) {
        queryMasterServer(
            // hl2master.steampowered.com:27011 - specifying specific ip my local called. for some reason whatever server deployed
            // was calling would return thousands of duplicate ips and only half of the actual server list
            '208.64.200.65:27011',
            REGIONS.ALL,
            { appid: appid },
            30000,
            10000
        ).then(servers => {
            const filtered = union([servers])

            console.log(`${cacheKey}/${appid} server list update [${filtered.length} servers (${servers.length} returned, ${servers.length - filtered.length} dupe(s))]`)

            masterCache.set(cacheKey, servers)
        }).catch((err) => {
            console.error("Failed to query master server list", err);
        });
    }
    queryServersForAppId(686810, "live_servers")
    queryServersForAppId(1504860, "pte_servers")
}
setInterval(masterServerQuery, moment.duration(10, 'minutes').asMilliseconds())
masterServerQuery()


const serverTTL = moment.duration(7, 'days');
const serverTTLSec = serverTTL.asSeconds();
const infoCache = new NodeCache({stdTTL: serverTTLSec, checkperiod: checkperiod});
const rulesCache = new NodeCache({stdTTL: serverTTLSec, checkperiod: checkperiod});
const playerTTL = moment.duration(2.5, 'minutes').asSeconds();
const playerCache = new NodeCache({stdTTL: playerTTL, checkperiod: checkperiod});
const mapCache = new NodeCache({stdTTL: serverTTLSec, checkperiod: checkperiod});

let known_maps = [
    'CT', 'CT_N', 'Driel', 'Driel_N', 'Driel_Day', 'elalamein', 'elalamein_N', 'Foy', 'Foy_N', 'Hill400',
    'Hill400_N', 'Hurtgen', 'Hurtgen_N', 'Kharkov', 'Kharkov_N', 'Kursk', 'Kursk_N', 'Mortain', 'Mortain_O',
    'Omaha', 'Omaha_N', 'PHL', 'PHL_N', 'Remagen', 'Remagen_N', 'Stalin', 'Stalin_N', 'StMarie', 'StMarie_N',
    'SME', 'SME_N', 'Utah', 'Utah_N', 'DEV_C_Day_SKM', 'DEV_C_Night_SKM', 'DEV_C_SKM', 'DEV_D_Day_SKM',
    'DEV_D_Night_SKM', 'DEV_D_SKM', 'DEV_F_DAY_SKM', 'DEV_F_DUSK_SKM', 'DEV_F_RAIN_SKM', 'DEV_I_SKM',
    'DEV_I_MORNING_SKM', 'DEV_I_NIGHT_SKM', 'DEV_M_Night_SKM', 'DEV_M_Rain_SKM', 'DEV_M_SKM', 'Mortain_SKM_Day',
    'Mortain_SKM_Overcast', 'Mortain_E', 'Mortain_SKM_Evening'
]
let unknown_maps = {}
let update = {
    time: new Date(),
    status: "startup",
    servers: [],
    unknown_maps: unknown_maps,
}

const pollInterval = moment.duration(15, 'seconds').asMilliseconds()

function pollServers() {
    console.log("pollServers()")

    const addresses = union([masterCache.get("live_servers") || [], masterCache.get("pte_servers") || [], infoCache.keys() || []])
    console.log(`${addresses.length} addresses`)

    const server_infos = []
    const server_fails = []
    const start = new Date()
    const promises = []
    for (let i = 0; i < addresses.length; i++) {
        const server = addresses[i];

        promises.push(new Promise(resolve => {
            queryGameServerInfo(server, 3, 5000).then(info => {
                const stripped_info = {
                    name: info?.name || "",
                    map: info?.map || "",
                    players: info?.players || 0,
                    maxPlayers: info?.maxPlayers || 0,
                    visibility: info?.visibility,
                    port: info?.port,
                    query: server,
                }

                const gsBase64 = info?.keywords?.split(",")?.find(str => str.startsWith("GS"))?.split(":")?.[1];
                if (gsBase64) {
                    stripped_info.gamestate = decodeGs(gsBase64);
                }

                if (info?.map && !known_maps.includes(info?.map)) {
                    const map = info.map;
                    const serverKey = `query=${server} port=${stripped_info.port} name=${stripped_info.name}`
                    let gsKey;
                    let decoded = stripped_info?.gamestate?.decoded;
                    if (decoded) {
                        gsKey = `gamemode=${decoded.gamemode} map=${decoded.map} timeOfDay=${decoded.timeOfDay} weather=${decoded.weather} offSide=${decoded.offensiveSide} version=${decoded.version}`
                    }
                    if (!unknown_maps.hasOwnProperty(map)) {
                        unknown_maps[map] = {
                            servers: [],
                            gsValues: [],
                        }
                    }
                    if (!unknown_maps[map].servers.includes(serverKey)) {
                        unknown_maps[map].servers.push(serverKey)
                    }
                    if (!unknown_maps[map].gsValues.includes(gsKey)) {
                        unknown_maps[map].gsValues.push(gsKey)
                    }
                }

                promises.push(new Promise(resolve => {
                    setTimeout(() => {
                        queryGameServerRules(server, 2, 5000).then(rules => {
                            rulesCache.set(server, rules);

                            resolve()
                        }).catch(err => {
                            console.error(`failed query rules ${server} ${infoCache.get(server)?.name}`);
                            resolve()
                        })
                    }, 200);
                }))

                if (stripped_info.players > 0) {
                    promises.push(new Promise(resolve => {
                        setTimeout(() => {
                            queryGameServerPlayer(server, 2, 5000).then(response => {
                                const players_stripped = []
                                response.players.forEach(player => {
                                    players_stripped.push({name: player.name, duration: Math.ceil(player.duration)})
                                });
                                playerCache.set(server, players_stripped);

                                resolve()
                            }).catch(err => {
                                console.error(`failed query players ${server} ${infoCache.get(server)?.name}`);
                                resolve()
                            })
                        }, 200);
                    }))
                }

                infoCache.set(server, stripped_info)
                server_infos.push(stripped_info)
                resolve()
            }).catch(err => {
                console.error(`failed query info ${server} ${infoCache.get(server)?.name}`);

                const info = infoCache.get(server);
                const stripped_info = {
                    name: info?.name || "",
                    map: info?.map || "",
                    players: info?.players || 0,
                    maxPlayers: info?.maxPlayers || 0,
                    visibility: info?.visibility,
                    port: info?.port,
                    query: server,

                    last_success: infoCache.getTtl(server) - serverTTL.asMilliseconds()
                }

                server_fails.push(stripped_info)
                resolve()
            });
        }));
    }

    Promise.all(promises).then(() => {
        update = {
            time: new Date(),
            status: `good: ${server_infos.length} servers`,
            servers: server_infos,
            failures: server_fails,
            unknown_maps: unknown_maps,
        }

        server_infos.forEach(info => {
            let change = mapCache.get(info.query);
            if (!mapCache.has(info.query)) {
                change = {
                    map: info.map,
                    state: 'init',
                    time: new Date(),
                }
                mapCache.set(info.query, change)
            } else if (info.map !== change.map) {
                change = {
                    map: info.map,
                    state: 'change',
                    time: new Date(),
                    had_players: info.players > 0,
                }
                mapCache.set(info.query, change)
            }

            if (change && change.state === 'change' && change.had_players) {
                info.map_change = change.time
            }

            if (playerCache.has(info.query)) {
                info.player_list = playerCache.get(info.query);
            }
            if (rulesCache.has(info.query)) {
                info.rules = rulesCache.get(info.query)?.rules || null;
            }
        });

        console.log(`done ${update.status}`)
        console.log(`query took ${(new Date() - start) / 1000} seconds`)

        io.sockets.emit("list-update", update)

        setTimeout(pollServers, pollInterval)
    }).catch(err => {
        console.error(err)

        setTimeout(pollServers, pollInterval)
    })
}
pollServers()


io.on('connection', (socket) => {
    console.log(`${socket.id} joined`)

    socket.on('disconnect', (socket) => {
        console.log(`${socket.id} left`)
    });

    io.to(socket.id).emit("list-update", update)
});

server.listen(process.env.PORT || 3000, () => {
    console.log('listening on *:3000');
});