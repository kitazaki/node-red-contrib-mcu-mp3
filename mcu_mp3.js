module.exports = function(RED) {
    function Mp3(config) {
        RED.nodes.createNode(this,config);
        console.log(config);
    }
    RED.nodes.registerType("mcu_mp3",Mp3);
}
