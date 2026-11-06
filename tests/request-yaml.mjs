import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {initAppContext} from '../src/host/appContext.js';
import {parseAiRequestOptions} from '../src/aiRewrite/requestOptions.js';
import {buildAiRewriteGenerateRawConfig} from '../src/aiRewrite/generation.js';
import {buildAiRewriteProxyBody} from '../src/aiRewrite/isolatedRequest.js';

// Point VERIDIS_YAML_MODULE at the host's installed yaml package when testing outside the host tree.
const yaml=createRequire(import.meta.url)(process.env.VERIDIS_YAML_MODULE||'yaml');
initAppContext({parseYaml:text=>yaml.parse(text,{maxAliasCount:50})});

test('native YAML examples reach both transports with exclusion priority',()=>{
 const config=buildAiRewriteGenerateRawConfig('fixture',{
  additionalParameters:'reasoning_effort: none\nthinking:\n  enabled: false\n  budget_tokens: 0\ntop_k: 20\nrepetition_penalty: 1.1',
  excludedParameters:'- frequency_penalty\n- presence_penalty\n- top_k\n- top_k'});
 assert.deepEqual(config.custom_api.custom_include_body,{response_format:{type:'json_object'},reasoning_effort:'none',thinking:{enabled:false,budget_tokens:0},repetition_penalty:1.1});
 assert.deepEqual(config.custom_api.custom_exclude_body,['frequency_penalty','presence_penalty','top_k']);
 const body=buildAiRewriteProxyBody(config);
 assert.deepEqual(JSON.parse(body.custom_include_body),config.custom_api.custom_include_body);
 assert.deepEqual(JSON.parse(body.custom_exclude_body),config.custom_api.custom_exclude_body);
});
test('old JSON and comma/newline exclusion lists retain their meaning',()=>{
 assert.deepEqual(parseAiRequestOptions({additionalParameters:'{"reasoning_effort":"none","temperature":0}',excludedParameters:'temperature, frequency_penalty\npresence_penalty'}),{additional:{reasoning_effort:'none'},excluded:['temperature','frequency_penalty','presence_penalty']});
});
test('YAML comments, document marker and flow list are supported',()=>{
 for(const excludedParameters of ['# comment\n- top_k','---\n- top_k','[top_k]'])assert.deepEqual(parseAiRequestOptions({excludedParameters}).excluded,['top_k']);
});
test('shared YAML aliases remain serializable and preserve their values',()=>{
 const value=parseAiRequestOptions({additionalParameters:'first: &options\n  enabled: false\nsecond: *options'}).additional;
 assert.deepEqual(JSON.parse(JSON.stringify(value)),{first:{enabled:false},second:{enabled:false}});
});
for(const additionalParameters of ['key: [','key: 1\nkey: 2','- wrong-shape','null','stream: true','nested:\n  constructor: bad','nested:\n  __proto__: bad','nested: &loop\n  self: *loop']){
 test('invalid or unsafe YAML is rejected before transport: '+additionalParameters,()=>assert.throws(()=>buildAiRewriteGenerateRawConfig('fixture',{additionalParameters})));
}
test('amplifying aliases are bounded by the host parser',()=>{
 const text='a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]';
 assert.throws(()=>parseAiRequestOptions({additionalParameters:text}));
});
for(const excludedParameters of ['- 42','- null','- [nested]','- ""','{top_k: 0}','[broken']){
 test('exclusions must contain field names: '+excludedParameters,()=>assert.throws(()=>parseAiRequestOptions({excludedParameters})));
}
test('excluding stream removes an otherwise unsupported override',()=>{
 assert.deepEqual(parseAiRequestOptions({additionalParameters:'stream: true',excludedParameters:'- stream'}),{additional:{},excluded:['stream']});
});
test('JSON keeps working without host YAML support and YAML fails clearly',()=>{
 initAppContext({parseYaml:null});
 try{
  assert.deepEqual(parseAiRequestOptions({additionalParameters:'{"reasoning_effort":"none"}'}).additional,{reasoning_effort:'none'});
  assert.throws(()=>parseAiRequestOptions({additionalParameters:'reasoning_effort: none'}),/YAML 解析器/);
 }finally{initAppContext({parseYaml:text=>yaml.parse(text,{maxAliasCount:50})})}
});
