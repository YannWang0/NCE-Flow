#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NCE-Flow 字幕翻译纠正脚本
使用 SiliconFlow GLM-4.6 模型智能纠正 .lrc 字幕文件中的中文翻译
严格保持原有格式，确保 NCE-Flow 程序能正常解析
"""

import os
import re
import time
import json
import getpass
from pathlib import Path
from typing import List, Dict, Tuple
import requests
from datetime import datetime


class TranslationFixer:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.siliconflow.cn/v1/chat/completions"
        self.model = "zai-org/GLM-4.6"

        # 速率限制：RPM 10000, TPM 400000
        self.max_rpm = 10000
        self.max_tpm = 400000
        self.request_count = 0
        self.token_count = 0
        self.start_time = time.time()

        # 统计信息
        self.total_files = 0
        self.processed_files = 0
        self.modified_files = 0
        self.error_files = []

    def rate_limit_check(self, estimated_tokens: int = 2000):
        """检查并控制请求频率"""
        current_time = time.time()
        elapsed = current_time - self.start_time

        # 如果超过1分钟，重置计数器
        if elapsed >= 60:
            self.request_count = 0
            self.token_count = 0
            self.start_time = current_time
            return

        # 检查是否需要等待
        if self.request_count >= self.max_rpm - 10 or self.token_count + estimated_tokens >= self.max_tpm:
            wait_time = 60 - elapsed + 1
            print(f"  ⏳ 接近速率限制，等待 {wait_time:.1f} 秒...")
            time.sleep(wait_time)
            self.request_count = 0
            self.token_count = 0
            self.start_time = time.time()

    def parse_lrc_file(self, file_path: str) -> Tuple[List[str], List[Dict]]:
        """
        解析 LRC 文件，分离元数据和字幕内容
        返回：(元数据行列表, 字幕数据列表)
        """
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        metadata = []
        subtitles = []

        # LRC 时间轴格式：[mm:ss.xx]
        time_pattern = re.compile(r'^\[(\d{2}:\d{2}\.\d{2})\](.+)$')

        for line in lines:
            line = line.rstrip('\n')  # 保留可能的空行

            # 元数据行：[al:], [ar:], [ti:], [by:]
            if line.startswith('[') and any(tag in line for tag in ['[al:', '[ar:', '[ti:', '[by:']):
                metadata.append(line)
            # 字幕行：[时间]内容
            elif time_pattern.match(line):
                match = time_pattern.match(line)
                timestamp = match.group(1)
                content = match.group(2)

                # 检查是否有双语内容（英文|中文）
                if '|' in content:
                    parts = content.split('|', 1)
                    english = parts[0]
                    chinese = parts[1] if len(parts) > 1 else ''
                    subtitles.append({
                        'timestamp': timestamp,
                        'english': english,
                        'chinese': chinese,
                        'has_translation': True,
                        'original_line': line
                    })
                else:
                    # 没有翻译的行，保持原样
                    subtitles.append({
                        'timestamp': timestamp,
                        'content': content,
                        'has_translation': False,
                        'original_line': line
                    })
            # 空行或其他行
            else:
                if line:  # 非空行作为元数据
                    metadata.append(line)
                else:  # 空行
                    subtitles.append({'empty': True, 'original_line': ''})

        return metadata, subtitles

    def check_and_fix_translations(self, subtitles: List[Dict], lesson_title: str) -> Tuple[List[Dict], bool]:
        """
        使用 AI 检查并纠正翻译
        返回：(修正后的字幕列表, 是否有修改)
        """
        # 提取需要检查的双语句子
        bilingual_pairs = []
        for idx, sub in enumerate(subtitles):
            if sub.get('has_translation', False):
                bilingual_pairs.append({
                    'index': idx,
                    'english': sub['english'],
                    'chinese': sub['chinese']
                })

        if not bilingual_pairs:
            print(f"  ℹ️  无双语内容，跳过")
            return subtitles, False

        print(f"  📊 找到 {len(bilingual_pairs)} 条双语字幕")

        # 构建 AI 提示
        print(f"  🔨 构建 AI 提示...")
        prompt = self._build_prompt(bilingual_pairs, lesson_title)
        estimated_tokens = len(prompt) + 2000
        print(f"  📏 预估 token 数: {estimated_tokens}")

        # 调用 API
        try:
            print(f"  🔍 检查速率限制...")
            self.rate_limit_check(estimated_tokens=estimated_tokens)

            print(f"  🚀 发送 API 请求到 {self.model}...")
            start_time = time.time()

            response = requests.post(
                self.base_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": self.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": "你是一位精通英语教学的专业翻译，擅长为中国学生提供准确、自然的新概念英语教材翻译。"
                        },
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    "temperature": 0.3,
                    "max_tokens": 4000
                },
                timeout=30
            )

            elapsed = time.time() - start_time
            print(f"  ✅ API 响应成功 (耗时 {elapsed:.2f}s)")

            self.request_count += 1

            if response.status_code != 200:
                print(f"  ❌ API 请求失败：{response.status_code} - {response.text}")
                return subtitles, False

            result = response.json()
            tokens_used = result.get('usage', {}).get('total_tokens', 0)
            self.token_count += tokens_used
            print(f"  📊 使用 token: {tokens_used} (累计: {self.token_count})")

            # 解析 AI 返回的结果
            print(f"  🔍 解析 AI 响应...")
            ai_response = result['choices'][0]['message']['content']
            corrections = self._parse_ai_response(ai_response)

            if not corrections:
                print(f"  ✓  AI 认为翻译准确，无需修改")
                return subtitles, False

            print(f"  📝 发现 {len(corrections)} 处需要修正")

            # 应用修正
            modified = False
            for correction in corrections:
                idx = correction['index']
                new_chinese = correction['corrected_chinese']
                reason = correction.get('reason', '无说明')

                if subtitles[idx]['chinese'] != new_chinese:
                    print(f"\n    ✏️  修正 #{idx + 1} [{subtitles[idx]['timestamp']}]:")
                    print(f"       英文: {subtitles[idx]['english']}")
                    print(f"       原译: {subtitles[idx]['chinese']}")
                    print(f"       新译: {new_chinese}")
                    print(f"       理由: {reason}")
                    subtitles[idx]['chinese'] = new_chinese
                    modified = True

            return subtitles, modified

        except requests.Timeout:
            print(f"  ❌ API 请求超时（30秒）")
            return subtitles, False
        except requests.RequestException as e:
            print(f"  ❌ 网络错误: {str(e)}")
            return subtitles, False
        except Exception as e:
            print(f"  ❌ 处理出错: {str(e)}")
            import traceback
            traceback.print_exc()
            return subtitles, False

    def _build_prompt(self, bilingual_pairs: List[Dict], lesson_title: str) -> str:
        """构建发送给 AI 的提示"""
        pairs_text = ""
        for i, pair in enumerate(bilingual_pairs):
            pairs_text += f"{i}. 英文: {pair['english']}\n   中文: {pair['chinese']}\n\n"

        prompt = f"""请仔细检查以下新概念英语课文《{lesson_title}》的双语字幕翻译，纠正其中生硬、不准确或不自然的中文翻译。

**重要说明：**
1. 这是新概念英语教材，每句话都有特定的教学目的和场景
2. **翻译原则**：
   - 要参考上下文理解语境，但主要关注每句话本身的准确性
   - 不要因为上下文而改变单句的教学意图
   - 每句话都是独立的教学单元，要确保单句翻译的准确性和教学价值
3. **避免直译错误**：
   - 习语和固定表达要用地道的中文（如 "How do you do?" → "你好"，而非"你是怎么做到的"）
   - "Pardon?" → "什么？请再说一遍"，而非"原谅？"
   - "Good for you!" → "你真棒！"，而非"对你有好处"
4. **符合中国学生习惯**：
   - 翻译要自然、口语化
   - 适合初学者理解
   - 保持教学场景的真实感
5. 只纠正明显错误的翻译，准确的翻译请保持不变

**字幕内容：**
{pairs_text}

**请以JSON格式返回需要修正的翻译，格式如下：**
```json
[
  {{"index": 0, "corrected_chinese": "修正后的中文翻译", "reason": "修正理由"}},
  {{"index": 2, "corrected_chinese": "修正后的中文翻译", "reason": "修正理由"}}
]
```

如果某句翻译准确无需修改，则不要在返回结果中包含它。只返回需要修正的句子。
"""
        return prompt

    def _parse_ai_response(self, response: str) -> List[Dict]:
        """解析 AI 返回的 JSON 结果"""
        try:
            # 提取 JSON 部分（可能被 ```json ``` 包裹）
            json_match = re.search(r'```json\s*(\[.*?\])\s*```', response, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                # 尝试直接查找 JSON 数组
                json_match = re.search(r'(\[.*?\])', response, re.DOTALL)
                if json_match:
                    json_str = json_match.group(1)
                else:
                    return []

            corrections = json.loads(json_str)
            return corrections if isinstance(corrections, list) else []
        except Exception as e:
            print(f"  ⚠️  解析 AI 响应失败: {str(e)}")
            return []

    def reconstruct_lrc_file(self, metadata: List[str], subtitles: List[Dict]) -> str:
        """重新组装 LRC 文件内容，严格保持原格式"""
        lines = []

        # 添加元数据
        for meta in metadata:
            lines.append(meta)

        # 添加字幕
        for sub in subtitles:
            if sub.get('empty', False):
                lines.append('')
            elif sub.get('has_translation', False):
                # 重建双语字幕行
                line = f"[{sub['timestamp']}]{sub['english']}|{sub['chinese']}"
                lines.append(line)
            else:
                # 保持原样
                lines.append(sub['original_line'])

        return '\n'.join(lines) + '\n'

    def process_file(self, file_path: str):
        """处理单个 LRC 文件"""
        try:
            file_name = os.path.basename(file_path)
            print(f"\n{'='*60}")
            print(f"📄 [{self.processed_files + 1}/{self.total_files}] {file_name}")
            print(f"{'='*60}")

            # 解析文件
            print(f"  📖 读取并解析文件...")
            metadata, subtitles = self.parse_lrc_file(file_path)
            print(f"  ✓  元数据: {len(metadata)} 行")
            print(f"  ✓  字幕内容: {len(subtitles)} 行")

            # 提取课程标题
            lesson_title = file_name.replace('.lrc', '')

            # 检查并修正翻译
            corrected_subtitles, modified = self.check_and_fix_translations(subtitles, lesson_title)

            # 如果有修改，保存文件
            if modified:
                print(f"\n  💾 保存修改...")
                # 备份原文件
                backup_path = file_path + '.backup'
                os.rename(file_path, backup_path)
                print(f"  ✓  已创建备份")

                # 写入修正后的内容
                new_content = self.reconstruct_lrc_file(metadata, corrected_subtitles)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f"  ✓  已写入新内容")

                # 删除备份
                os.remove(backup_path)
                print(f"  ✓  已删除备份")

                self.modified_files += 1
                print(f"\n  ✅ 文件已更新")
            else:
                print(f"\n  ✅ 翻译准确，无需修改")

            self.processed_files += 1

        except Exception as e:
            print(f"\n  ❌ 处理失败: {str(e)}")
            import traceback
            traceback.print_exc()
            self.error_files.append(file_path)
            self.processed_files += 1

    def process_all_files(self):
        """处理所有 NCE 文件夹中的 LRC 文件"""
        folders = ['NCE1', 'NCE2', 'NCE3', 'NCE4']
        all_files = []

        # 收集所有 LRC 文件
        print(f"\n🔍 扫描文件夹...")
        for folder in folders:
            folder_path = Path(folder)
            if folder_path.exists():
                lrc_files = list(folder_path.glob('*.lrc'))
                print(f"  {folder}: {len(lrc_files)} 个文件")
                all_files.extend([str(f) for f in lrc_files])
            else:
                print(f"  ⚠️  {folder} 不存在")

        self.total_files = len(all_files)
        print(f"\n🎯 共找到 {self.total_files} 个 LRC 文件")
        print(f"⏱️  开始处理...")

        # 逐个处理
        for file_path in all_files:
            self.process_file(file_path)

        # 显示总结
        print(f"\n{'='*60}")
        print(f"✨ 处理完成！")
        print(f"{'='*60}")
        print(f"📊 统计信息:")
        print(f"   总文件数: {self.total_files}")
        print(f"   已处理: {self.processed_files}")
        print(f"   已修改: {self.modified_files}")
        print(f"   失败: {len(self.error_files)}")
        print(f"   成功率: {(self.processed_files - len(self.error_files)) / self.total_files * 100:.1f}%")
        print(f"\n⚡ API 使用:")
        print(f"   总请求数: {self.request_count}")
        print(f"   总 Token: {self.token_count}")

        if self.error_files:
            print(f"\n❌ 以下文件处理失败：")
            for f in self.error_files:
                print(f"   - {os.path.basename(f)}")


def main():
    print("="*60)
    print("  NCE-Flow 字幕翻译纠正工具")
    print("  使用 SiliconFlow GLM-4.6 智能纠正翻译")
    print("="*60)

    # 获取 API Key
    api_key = getpass.getpass("\n请输入你的 SiliconFlow API Key: ")

    if not api_key:
        print("❌ API Key 不能为空！")
        return

    # 确认开始
    print("\n⚠️  即将开始处理所有 LRC 文件，原文件会被修改（处理前会自动备份）")
    confirm = input("确认开始？(yes/no): ")

    if confirm.lower() not in ['yes', 'y']:
        print("❌ 已取消")
        return

    # 开始处理
    fixer = TranslationFixer(api_key)
    start_time = datetime.now()

    fixer.process_all_files()

    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()
    print(f"\n⏱️  总耗时: {duration:.1f} 秒")


if __name__ == "__main__":
    main()
